import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import ICAL from "ical.js";
import { type CalDAVClient, CalDAVError } from "ts-caldav";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";

const APPLE_JR_FIREBALLS_ICS = [
	"BEGIN:VCALENDAR",
	"CALSCALE:GREGORIAN",
	"PRODID:-//Apple Inc.//iPhone OS 27.2//EN",
	"VERSION:2.0",
	"BEGIN:VTIMEZONE",
	"TZID:America/Los_Angeles",
	"BEGIN:DAYLIGHT",
	"DTSTART:20070311T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
	"TZNAME:PDT",
	"TZOFFSETFROM:-0800",
	"TZOFFSETTO:-0700",
	"END:DAYLIGHT",
	"BEGIN:STANDARD",
	"DTSTART:20071104T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
	"TZNAME:PST",
	"TZOFFSETFROM:-0700",
	"TZOFFSETTO:-0800",
	"END:STANDARD",
	"END:VTIMEZONE",
	"BEGIN:VEVENT",
	"UID:fireballs-1",
	"SUMMARY:Leor - Jr Fireballs",
	"DTSTART;TZID=America/Los_Angeles:20261006T154500",
	"DTEND;TZID=America/Los_Angeles:20261006T163000",
	"RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
	"LOCATION:Foothills Club",
	'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="Foothills Club":geo:37.39,-122.13',
	"SEQUENCE:0",
	"BEGIN:VALARM",
	"ACTION:DISPLAY",
	"DESCRIPTION:Reminder",
	"TRIGGER:-PT30M",
	"END:VALARM",
	"END:VEVENT",
	"END:VCALENDAR",
].join("\r\n");

function makeRawStore(initial: Record<string, string>) {
	const files = new Map<string, { etag: string; ics: string }>();
	let rev = 1;
	for (const [href, ics] of Object.entries(initial)) {
		files.set(href, { etag: `"etag-${rev}"`, ics });
		rev += 1;
	}

	const getIcs = vi.fn((href: string) => {
		const entry = files.get(href);
		if (!entry) {
			return Promise.reject(new CalDAVError("Not Found", 404));
		}
		return Promise.resolve({ etag: entry.etag, ics: entry.ics });
	});

	const mkIcsPut = vi.fn(
		(href: string, ics: string, _headers?: Record<string, string>) => {
			rev += 1;
			const etag = `"etag-${rev}"`;
			files.set(href, { etag, ics });
			return Promise.resolve({ headers: { etag } });
		}
	);

	const deleteResource = vi.fn((href: string) => {
		files.delete(href);
		return Promise.resolve();
	});

	const client = {
		baseUrl: "https://caldav.icloud.com",
		deleteEvent: vi.fn((calUrl: string, uid: string) => {
			const base = calUrl.endsWith("/") ? calUrl : `${calUrl}/`;
			files.delete(`${base}${uid}.ics`);
			return Promise.resolve();
		}),
		getCalendars: vi.fn().mockResolvedValue([]),
		getETag: vi.fn((href: string) =>
			Promise.resolve(files.get(href)?.etag ?? '"etag"')
		),
		getEvents: vi.fn().mockResolvedValue([]),
		getIcs,
		mkIcsPut,
		occurrenceDeps: () => ({
			absolutize: (u: string) => u,
			deleteResource,
		}),
	} as unknown as CalDAVClient;

	return { client, deleteResource, files, getIcs, mkIcsPut };
}

async function connectMcp(client: CalDAVClient) {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createServer(client).connect(serverSide);
	const mcp = new Client({ name: "test", version: "0.1.0" });
	await mcp.connect(clientSide);
	return mcp;
}

describe("recurring event EXDATE skips, single-occurrence overrides, and TZID creation", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("skips two occurrences in one PUT with TZID-matching EXDATEs while preserving VTIMEZONE, alarms, and Apple metadata", async () => {
		const href = "/cal/fireballs-1.ics";
		const { client, files, mkIcsPut } = makeRawStore({
			[href]: APPLE_JR_FIREBALLS_ICS,
		});
		const mcp = await connectMcp(client);

		const res = await mcp.callTool({
			arguments: {
				calendarUrl: "https://caldav.icloud.com/cal/",
				occurrenceDates: [
					"2026-11-24T15:45:00-08:00",
					"2026-11-26", // date-only resolution across PDT->PST transition
				],
				uid: "fireballs-1",
			},
			name: "delete-event",
		});

		const text = (res.content as { text: string }[])[0]?.text ?? "";
		expect(text).toContain("Skipped 2 occurrences");
		expect(mkIcsPut).toHaveBeenCalledTimes(1);

		const saved = files.get(href)?.ics ?? "";
		expect(saved).toContain("EXDATE;TZID=America/Los_Angeles:20261124T154500");
		expect(saved).toContain("EXDATE;TZID=America/Los_Angeles:20261126T154500");
		expect(saved).toContain("BEGIN:VTIMEZONE");
		expect(saved).toContain("BEGIN:VALARM");
		expect(saved).toContain("X-APPLE-STRUCTURED-LOCATION");
		expect(saved).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU,TH");

		// Inspect via get-event and confirm exdates and recurrenceRule are reported.
		const infoRes = await mcp.callTool({
			arguments: { calendarUrl: "/cal/", uid: "fireballs-1" },
			name: "get-event",
		});
		const info = JSON.parse(
			(infoRes.content as { text: string }[])[0]?.text ?? "null"
		);
		expect(info).toMatchObject({
			exdates: ["2026-11-24T23:45:00.000Z", "2026-11-26T23:45:00.000Z"],
			recurrenceRule: { byday: ["TU", "TH"], freq: "WEEKLY" },
			summary: "Leor - Jr Fireballs",
			timezone: "America/Los_Angeles",
			uid: "fireballs-1",
		});

		await mcp.close();
	});

	it("overrides a single occurrence with RECURRENCE-ID without altering the master series", async () => {
		const href = "/cal/fireballs-1.ics";
		const { client, files } = makeRawStore({
			[href]: APPLE_JR_FIREBALLS_ICS,
		});
		const mcp = await connectMcp(client);

		await mcp.callTool({
			arguments: {
				calendarUrl: "/cal/",
				end: "2026-11-20T16:45:00-08:00",
				location: "Court 4",
				occurrenceDate: "2026-11-19",
				start: "2026-11-20T16:00:00-08:00",
				uid: "fireballs-1",
			},
			name: "update-event",
		});

		const saved = files.get(href)?.ics ?? "";
		const vcal = new ICAL.Component(ICAL.parse(saved));
		const vevents = vcal.getAllSubcomponents("vevent");
		expect(vevents).toHaveLength(2);

		const master = vevents.find((v) => !v.getFirstProperty("recurrence-id"));
		const override = vevents.find((v) => v.getFirstProperty("recurrence-id"));
		expect(master?.getFirstPropertyValue("location")).toBe("Foothills Club");
		expect(
			master?.getFirstProperty("x-apple-structured-location")
		).not.toBeNull();

		expect(saved).toContain(
			"RECURRENCE-ID;TZID=America/Los_Angeles:20261119T154500"
		);
		expect(saved).toContain("DTSTART;TZID=America/Los_Angeles:20261120T160000");
		expect(override?.getFirstPropertyValue("location")).toBe("Court 4");
		expect(
			override?.getFirstProperty("x-apple-structured-location")
		).toBeNull();

		await mcp.close();
	});

	it("truncates a series cleanly with scope='thisAndFuture' and deletes outright when cutting at the first occurrence", async () => {
		const href = "/cal/fireballs-1.ics";
		const { client, deleteResource, files } = makeRawStore({
			[href]: APPLE_JR_FIREBALLS_ICS,
		});
		const mcp = await connectMcp(client);

		const cutRes = await mcp.callTool({
			arguments: {
				calendarUrl: "/cal/",
				occurrenceDate: "2026-11-24",
				scope: "thisAndFuture",
				uid: "fireballs-1",
			},
			name: "delete-event",
		});
		expect((cutRes.content as { text: string }[])[0]?.text).toContain(
			"Recurring series ended before"
		);
		expect(files.get(href)?.ics).toContain("UNTIL=20261124T234459Z");

		// Cutting at the very first occurrence (2026-10-06) deletes the whole resource.
		const delRes = await mcp.callTool({
			arguments: {
				calendarUrl: "/cal/",
				occurrenceDate: "2026-10-06",
				scope: "thisAndFuture",
				uid: "fireballs-1",
			},
			name: "delete-event",
		});
		expect((delRes.content as { text: string }[])[0]?.text).toBe(
			"Event deleted"
		);
		expect(deleteResource).toHaveBeenCalledWith(
			"/cal/fireballs-1.ics",
			expect.any(String)
		);
		expect(files.has(href)).toBe(false);

		await mcp.close();
	});

	it("creates timed recurring events with TZID and an embedded VTIMEZONE when CALDAV_TIMEZONE is set", async () => {
		vi.stubEnv("CALDAV_TIMEZONE", "America/Los_Angeles");
		const { client, files } = makeRawStore({});
		const mcp = await connectMcp(client);

		const res = await mcp.callTool({
			arguments: {
				calendarUrl: "/cal/",
				end: "2026-10-06T16:30:00-07:00",
				recurrenceRule: { byday: ["TU", "TH"], freq: "WEEKLY" },
				start: "2026-10-06T15:45:00-07:00",
				summary: "Leor - Jr Fireballs",
			},
			name: "create-event",
		});
		const uid = (res.content as { text: string }[])[0]?.text ?? "";
		expect(uid).toBeTruthy();

		const saved = files.get(`/cal/${uid}.ics`)?.ics ?? "";
		expect(saved).toContain("BEGIN:VTIMEZONE");
		expect(saved).toContain("TZID:America/Los_Angeles");
		expect(saved).toContain("DTSTART;TZID=America/Los_Angeles:20261006T154500");
		expect(saved).toContain("DTEND;TZID=America/Los_Angeles:20261006T163000");
		expect(saved).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU,TH");

		await mcp.close();
	});

	it("returns expanded recurring flags and YYYY-MM-DD wholeDay dates from list-events", async () => {
		const { client } = makeRawStore({});
		(client.getEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				end: new Date("2026-11-24T23:30:00Z"),
				recurrenceId: new Date("2026-11-24T22:45:00Z"),
				start: new Date("2026-11-24T22:45:00Z"),
				summary: "Tennis",
				uid: "r-1",
				wholeDay: false,
			},
			{
				end: new Date(2026, 10, 28),
				start: new Date(2026, 10, 23),
				summary: "Fall Break",
				uid: "wd-1",
				wholeDay: true,
			},
		]);
		const mcp = await connectMcp(client);
		const res = await mcp.callTool({
			arguments: {
				calendarUrl: "/cal/",
				end: "2026-11-30T00:00:00Z",
				start: "2026-11-22T00:00:00Z",
			},
			name: "list-events",
		});
		const items = JSON.parse(
			(res.content as { text: string }[])[0]?.text ?? "[]"
		);
		expect(items).toEqual([
			{
				end: "2026-11-28",
				start: "2026-11-23",
				summary: "Fall Break",
				uid: "wd-1",
				wholeDay: true,
			},
			{
				end: "2026-11-24T23:30:00.000Z",
				recurrenceId: "2026-11-24T22:45:00.000Z",
				recurring: true,
				start: "2026-11-24T22:45:00.000Z",
				summary: "Tennis",
				uid: "r-1",
			},
		]);
		await mcp.close();
	});
});
