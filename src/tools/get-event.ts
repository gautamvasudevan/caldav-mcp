import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CalDAVClient } from "ts-caldav";
import { z } from "zod";
import { toCalendarPath } from "./caldav-href.js";
import { inspectMasterEvent } from "./ical-ics.js";

interface GetEventInput {
	calendarUrl: string;
	uid: string;
}

export const getEventDefinition = {
	description:
		"Fetch a single calendar event (or recurring series master) by UID, returning its summary, start, end, recurrenceRule, and excluded occurrence dates (exdates).",
	inputSchema: {
		calendarUrl: z.string(),
		uid: z.string().describe("Event or recurring series UID"),
	},
	name: "get-event",
	returns:
		"JSON object with the event or recurring series metadata, or `null` when not found",
} as const;

export function registerGetEvent(client: CalDAVClient, server: McpServer) {
	server.registerTool(
		getEventDefinition.name,
		{
			description: getEventDefinition.description,
			inputSchema: getEventDefinition.inputSchema,
		},
		async (args: GetEventInput) => {
			const calendarUrl = toCalendarPath(args.calendarUrl, client.baseUrl);
			const data = await inspectMasterEvent(client, calendarUrl, args.uid);
			return {
				content: [{ text: JSON.stringify(data), type: "text" }],
			};
		}
	);
}
