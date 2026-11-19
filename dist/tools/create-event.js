import { z } from "zod";
import { toCalendarPath } from "./caldav-href.js";
import { createEventIcs, defaultTimezone, hasRawIcsAccess, isValidTimezone, } from "./ical-ics.js";
import { recurrenceRuleSchema, toRecurrenceRule, } from "./recurrence-rule.js";
import { toWholeDayDate } from "./whole-day-date.js";
const isoOrDateSchema = z.union([
    z.string().datetime({ offset: true }),
    z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected ISO 8601 datetime or YYYY-MM-DD"),
]);
export const createEventDefinition = {
    description: "Creates an event in the calendar specified by its URL. For all-day events, set `wholeDay` to true (and pass `start` and `end` as the inclusive first and last calendar days). Timed events use `timezone` (or the server's `CALDAV_TIMEZONE`) so recurring events keep their local wall-clock time across Daylight Saving Time.",
    inputSchema: {
        calendarUrl: z.string(),
        description: z.string().optional(),
        end: isoOrDateSchema.describe("End datetime (ISO 8601) or YYYY-MM-DD for whole-day"),
        location: z.string().optional(),
        recurrenceRule: recurrenceRuleSchema.optional(),
        start: isoOrDateSchema.describe("Start datetime (ISO 8601) or YYYY-MM-DD for whole-day"),
        summary: z.string(),
        timezone: z
            .string()
            .refine((v) => isValidTimezone(v), { message: "Invalid IANA timezone" })
            .optional()
            .describe("Optional IANA timezone (e.g. 'America/Los_Angeles') for timed events; defaults to CALDAV_TIMEZONE when configured"),
        wholeDay: z.boolean().optional().describe("Create as a whole-day event"),
    },
    name: "create-event",
    returns: "The unique ID of the created event",
};
export function registerCreateEvent(client, server) {
    server.registerTool(createEventDefinition.name, {
        description: createEventDefinition.description,
        inputSchema: createEventDefinition.inputSchema,
    }, async (args) => {
        const { summary, start, end, wholeDay, description, location, recurrenceRule, timezone, } = args;
        const calendarUrl = toCalendarPath(args.calendarUrl, client.baseUrl);
        const tz = wholeDay ? undefined : (timezone ?? defaultTimezone());
        if (hasRawIcsAccess(client) && tz) {
            const uid = await createEventIcs(client, calendarUrl, {
                description,
                end,
                location,
                recurrenceRule,
                start,
                summary,
                timezone: tz,
                wholeDay,
            });
            return {
                content: [{ text: uid, type: "text" }],
            };
        }
        const event = await client.createEvent(calendarUrl, {
            end: wholeDay ? toWholeDayDate(end) : new Date(end),
            start: wholeDay ? toWholeDayDate(start) : new Date(start),
            summary,
            ...(wholeDay !== undefined && { wholeDay }),
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(recurrenceRule !== undefined && {
                recurrenceRule: toRecurrenceRule(recurrenceRule, wholeDay),
            }),
        });
        return {
            content: [{ text: event.uid, type: "text" }],
        };
    });
}
