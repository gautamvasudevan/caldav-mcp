import { z } from "zod";
import { toCalendarPath } from "./caldav-href.js";
import { localDateString } from "./ical-ics.js";
export const listEventsDefinition = {
    description: "List all events between start and end date in the calendar specified by its URL. Recurring series are expanded into individual occurrences by default (`recurring: true`, `recurrenceId` set to each occurrence's scheduled start). Whole-day (`wholeDay: true`) events return `YYYY-MM-DD` dates with an exclusive `end` date.",
    inputSchema: {
        calendarUrl: z.string(),
        end: z
            .string()
            .refine((val) => !Number.isNaN(Date.parse(val)), {
            message: "Invalid date string",
        })
            .describe("End date (ISO 8601)"),
        expand: z
            .boolean()
            .optional()
            .describe("Expand recurring events into individual occurrences in [start, end] (default: true). Set false to inspect unexpanded series masters."),
        start: z
            .string()
            .refine((val) => !Number.isNaN(Date.parse(val)), {
            message: "Invalid date string",
        })
            .describe("Start date (ISO 8601)"),
    },
    name: "list-events",
    returns: "A list of events falling within the timeframe, sorted by start, each containing `uid`, `summary`, `start`, `end`, and optionally `wholeDay`, `recurring`, `recurrenceId`, `recurrenceRule`, `description`, and `location`",
};
function serializeDate(date, wholeDay) {
    return wholeDay ? localDateString(date) : date.toISOString();
}
function serializeListedEvent(e) {
    const isWholeDay = Boolean(e.wholeDay);
    const recIdOut = e.recurrenceId
        ? serializeDate(e.recurrenceId, isWholeDay)
        : undefined;
    const isRecurring = recIdOut !== undefined || e.recurrenceRule !== undefined;
    return {
        end: serializeDate(e.end, isWholeDay),
        start: serializeDate(e.start, isWholeDay),
        summary: e.summary,
        uid: e.uid,
        ...(isWholeDay && { wholeDay: true }),
        ...(isRecurring && { recurring: true }),
        ...(recIdOut !== undefined && { recurrenceId: recIdOut }),
        ...(e.recurrenceRule !== undefined && { recurrenceRule: e.recurrenceRule }),
        ...(e.description && { description: e.description }),
        ...(e.location && { location: e.location }),
    };
}
export function registerListEvents(client, server) {
    server.registerTool(listEventsDefinition.name, {
        description: listEventsDefinition.description,
        inputSchema: listEventsDefinition.inputSchema,
    }, async (args) => {
        const { start, end, expand = true } = args;
        const calendarUrl = toCalendarPath(args.calendarUrl, client.baseUrl);
        const allEvents = await client.getEvents(calendarUrl, {
            end: new Date(end),
            expand,
            start: new Date(start),
        });
        const sorted = [...allEvents].sort((a, b) => a.start.getTime() - b.start.getTime());
        const data = sorted.map(serializeListedEvent);
        return {
            content: [{ text: JSON.stringify(data), type: "text" }],
        };
    });
}
