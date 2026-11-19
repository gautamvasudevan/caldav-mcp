import { z } from "zod";
import { hrefFor, toCalendarPath } from "./caldav-href.js";
import { hasRawIcsAccess, skipOrTruncateOccurrences } from "./ical-ics.js";
const isoOrDateSchema = z.union([
    z.string().datetime({ offset: true }),
    z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected ISO 8601 datetime or YYYY-MM-DD"),
]);
export const deleteEventDefinition = {
    description: "Deletes a calendar event, skips specific dates of a recurring series, or ends a recurring series from a date onward. IMPORTANT: For recurring events, pass `occurrenceDates` (one or more occurrence start datetimes or `YYYY-MM-DD` dates, e.g. `['2026-11-24T15:45:00-08:00', '2026-11-26T15:45:00-08:00']`) to skip ONLY those occurrences (`EXDATE`) in a single call while keeping past and future dates intact. Use `scope: 'thisAndFuture'` with `occurrenceDate` to end a recurring series from that date onward. Omit `occurrenceDates`/`occurrenceDate` ONLY when deleting the entire event or entire recurring series.",
    inputSchema: {
        calendarUrl: z.string(),
        occurrenceDate: isoOrDateSchema
            .optional()
            .describe("Single occurrence start datetime (ISO 8601 / recurrenceId from list-events) or YYYY-MM-DD to skip (or cut from when scope is 'thisAndFuture')"),
        occurrenceDates: z
            .array(isoOrDateSchema)
            .optional()
            .describe("One or more occurrence start datetimes (ISO 8601 / recurrenceId from list-events) or YYYY-MM-DD dates to skip from a recurring series (adds EXDATE entries without splitting the series)"),
        scope: z
            .enum(["this", "thisAndFuture"])
            .optional()
            .describe("With occurrenceDate(s): 'this' (default) skips only the specified date(s); 'thisAndFuture' ends the recurring series from the earliest specified date onward"),
        uid: z
            .string()
            .describe("Unique identifier of the event or recurring series (obtained from list-events)"),
    },
    name: "delete-event",
    returns: "Confirmation message describing whether specific occurrences were skipped, the series was truncated, or the entire event was deleted",
};
export function registerDeleteEvent(client, server) {
    server.registerTool(deleteEventDefinition.name, {
        description: deleteEventDefinition.description,
        inputSchema: deleteEventDefinition.inputSchema,
    }, async (args) => {
        const { uid, occurrenceDate, occurrenceDates, scope = "this" } = args;
        const calendarUrl = toCalendarPath(args.calendarUrl, client.baseUrl);
        const combinedDates = [
            ...(occurrenceDates ?? []),
            ...(occurrenceDate ? [occurrenceDate] : []),
        ];
        if (combinedDates.length > 0) {
            if (!hasRawIcsAccess(client)) {
                throw new Error("Occurrence skip/truncation requires raw ICS support");
            }
            const res = await skipOrTruncateOccurrences(client, calendarUrl, uid, combinedDates, scope);
            if (res.seriesDeleted) {
                return {
                    content: [{ text: "Event deleted", type: "text" }],
                };
            }
            if (scope === "thisAndFuture") {
                return {
                    content: [
                        {
                            text: `Recurring series ended before ${res.truncatedBefore ?? combinedDates[0]}`,
                            type: "text",
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        text: `Skipped ${res.skippedDates.length} occurrence${res.skippedDates.length === 1 ? "" : "s"}: ${res.skippedDates.join(", ")}`,
                        type: "text",
                    },
                ],
            };
        }
        const etag = await client.getETag(hrefFor(calendarUrl, uid));
        await client.deleteEvent(calendarUrl, uid, etag);
        return {
            content: [{ text: "Event deleted", type: "text" }],
        };
    });
}
