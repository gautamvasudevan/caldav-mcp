import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CalDAVClient } from "ts-caldav";
import { z } from "zod";
import { hrefFor, toCalendarPath } from "./caldav-href.js";
import {
	hasRawIcsAccess,
	isValidTimezone,
	overrideSingleOccurrence,
	updateMasterEventIcs,
} from "./ical-ics.js";
import {
	type RecurrenceRuleInput,
	recurrenceRuleSchema,
	toRecurrenceRule,
} from "./recurrence-rule.js";
import { carryOverWholeDayDates, toWholeDayDate } from "./whole-day-date.js";

const isoOrDateSchema = z.union([
	z.string().datetime({ offset: true }),
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected ISO 8601 datetime or YYYY-MM-DD"),
]);

interface UpdateEventInput {
	calendarUrl: string;
	description?: string | undefined;
	end?: string | undefined;
	excludeDates?: string[] | undefined;
	location?: string | undefined;
	occurrenceDate?: string | undefined;
	recurrenceRule?: RecurrenceRuleInput | undefined;
	start?: string | undefined;
	summary?: string | undefined;
	timezone?: string | undefined;
	uid: string;
	wholeDay?: boolean | undefined;
}

export const updateEventDefinition = {
	description:
		"Updates an existing event or recurring series in the calendar specified by its URL. Only provided fields are changed. To reschedule or edit ONLY ONE single occurrence of a recurring series (leaving all other dates unchanged), pass `occurrenceDate` set to that occurrence's original scheduled start (`recurrenceId` or `start` from `list-events`, or `YYYY-MM-DD`). To skip/cancel specific dates of a recurring series, prefer `delete-event` with `occurrenceDates` (or pass `excludeDates` here); never split a series in two just to skip dates.",
	inputSchema: {
		calendarUrl: z.string(),
		description: z.string().optional(),
		end: isoOrDateSchema.optional(),
		excludeDates: z
			.array(isoOrDateSchema)
			.optional()
			.describe(
				"Optional occurrence dates/datetimes to skip (adds EXDATE entries to a recurring series without splitting it)"
			),
		location: z.string().optional(),
		occurrenceDate: isoOrDateSchema
			.optional()
			.describe(
				"Original scheduled start datetime (ISO 8601 / recurrenceId from list-events) or YYYY-MM-DD of a single recurring occurrence to override ('Change This Event Only'), leaving the rest of the series intact"
			),
		recurrenceRule: recurrenceRuleSchema.optional(),
		start: isoOrDateSchema.optional(),
		summary: z.string().optional(),
		timezone: z
			.string()
			.refine((v) => isValidTimezone(v), { message: "Invalid IANA timezone" })
			.optional()
			.describe("Optional IANA timezone (e.g. 'America/Los_Angeles')"),
		uid: z
			.string()
			.describe(
				"Unique identifier of the event or recurring series to update (obtained from list-events)"
			),
		wholeDay: z
			.boolean()
			.optional()
			.describe("Update whether this is a whole-day event"),
	},
	name: "update-event",
	returns: "The unique ID of the updated event",
} as const;

async function fallbackClientUpdate(
	client: CalDAVClient,
	calendarUrl: string,
	args: UpdateEventInput
): Promise<string> {
	const {
		uid,
		summary,
		start,
		end,
		wholeDay,
		description,
		location,
		recurrenceRule,
	} = args;
	const href = hrefFor(calendarUrl, uid);
	const [existing] = await client.getEventsByHref(calendarUrl, [href]);
	if (!existing) {
		throw new Error(`Event not found: ${uid}`);
	}
	const effectiveWholeDay = wholeDay ?? existing.wholeDay;
	const updated = await client.updateEvent(calendarUrl, {
		...existing,
		...(effectiveWholeDay && carryOverWholeDayDates(existing)),
		...(summary !== undefined && { summary }),
		...(start !== undefined && {
			start: effectiveWholeDay ? toWholeDayDate(start) : new Date(start),
		}),
		...(end !== undefined && {
			end: effectiveWholeDay ? toWholeDayDate(end) : new Date(end),
		}),
		...(wholeDay !== undefined && { wholeDay }),
		...(description !== undefined && { description }),
		...(location !== undefined && { location }),
		...(recurrenceRule !== undefined && {
			recurrenceRule: toRecurrenceRule(recurrenceRule, effectiveWholeDay),
		}),
	});
	return updated.uid;
}

export function registerUpdateEvent(client: CalDAVClient, server: McpServer) {
	server.registerTool(
		updateEventDefinition.name,
		{
			description: updateEventDefinition.description,
			inputSchema: updateEventDefinition.inputSchema,
		},
		async (args: UpdateEventInput) => {
			const calendarUrl = toCalendarPath(args.calendarUrl, client.baseUrl);
			if (args.occurrenceDate !== undefined) {
				if (!hasRawIcsAccess(client)) {
					throw new Error(
						"Single-occurrence override requires raw ICS support"
					);
				}
				const updatedUid = await overrideSingleOccurrence(
					client,
					calendarUrl,
					args.uid,
					args.occurrenceDate,
					args
				);
				return { content: [{ text: updatedUid, type: "text" }] };
			}
			const updatedUid = hasRawIcsAccess(client)
				? await updateMasterEventIcs(client, calendarUrl, args.uid, args)
				: await fallbackClientUpdate(client, calendarUrl, args);
			return { content: [{ text: updatedUid, type: "text" }] };
		}
	);
}
