import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { CalDAVError } from "ts-caldav";
import { hrefFor } from "./caldav-href.js";
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;
const EXTENDED_UNTIL_RE = /^(?<head>RRULE[^\r\n]*?;?UNTIL=)(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?:T(?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})(?<z>Z?))?/gmu;
const MAX_EXPANSION_STEPS = 3000;
const SNAP_WINDOW_MS = 90 * MS_PER_MINUTE;
export function hasRawIcsAccess(client) {
    const raw = client;
    return typeof raw.getIcs === "function" && typeof raw.mkIcsPut === "function";
}
export function defaultTimezone() {
    const tz = process.env.CALDAV_TIMEZONE?.trim();
    return tz && isValidTimezone(tz) ? tz : undefined;
}
export function isValidTimezone(tzid) {
    try {
        const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tzid });
        return Boolean(fmt);
    }
    catch {
        return false;
    }
}
const formatterCache = new Map();
function getFormatter(tzid) {
    let fmt = formatterCache.get(tzid);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat("en-US", {
            day: "2-digit",
            hour: "2-digit",
            hourCycle: "h23",
            minute: "2-digit",
            month: "2-digit",
            second: "2-digit",
            timeZone: tzid,
            timeZoneName: "short",
            year: "numeric",
        });
        formatterCache.set(tzid, fmt);
    }
    return fmt;
}
const NUMERIC_PART_KEYS = [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
];
function wallPartsInZone(date, tzid) {
    const out = {
        day: 1,
        hour: 0,
        minute: 0,
        month: 1,
        second: 0,
        tzName: tzid,
        year: 1970,
    };
    for (const part of getFormatter(tzid).formatToParts(date)) {
        if (part.type === "timeZoneName") {
            out.tzName = part.value;
        }
        else if (NUMERIC_PART_KEYS.includes(part.type)) {
            out[part.type] = Number(part.value);
        }
    }
    return out;
}
function offsetMinutesAt(utcMs, tzid) {
    const w = wallPartsInZone(new Date(utcMs), tzid);
    const wallMs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return Math.round((wallMs - utcMs) / MS_PER_MINUTE);
}
function pad2(n) {
    return String(n).padStart(2, "0");
}
export function localDateString(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function dateStringInZone(date, tzid) {
    const w = wallPartsInZone(date, tzid);
    return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}
export function toZonedIcalTime(date, tzid) {
    const w = wallPartsInZone(date, tzid);
    return ICAL.Time.fromData({
        day: w.day,
        hour: w.hour,
        isDate: false,
        minute: w.minute,
        month: w.month,
        second: w.second,
        year: w.year,
    });
}
export function fromZonedIcalTime(time, tzid) {
    if (time.isDate) {
        return new Date(Date.UTC(time.year, time.month - 1, time.day));
    }
    if (tzid &&
        isValidTimezone(tzid) &&
        (!time.zone || time.zone === ICAL.Timezone.localTimezone)) {
        const wallUtc = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
        let instant = wallUtc - offsetMinutesAt(wallUtc, tzid) * MS_PER_MINUTE;
        instant = wallUtc - offsetMinutesAt(instant, tzid) * MS_PER_MINUTE;
        return new Date(instant);
    }
    return time.toJSDate();
}
function formatOffset(minutes) {
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}
function floatingWallIcalTime(utcMs, offsetMinutes) {
    const shifted = new Date(utcMs + offsetMinutes * MS_PER_MINUTE);
    return ICAL.Time.fromData({
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        isDate: false,
        minute: shifted.getUTCMinutes(),
        month: shifted.getUTCMonth() + 1,
        second: shifted.getUTCSeconds(),
        year: shifted.getUTCFullYear(),
    });
}
function bisectTransitionMinute(loStart, hiStart, prevOffset, tzid) {
    let lo = loStart;
    let hi = hiStart;
    while (hi - lo > MS_PER_MINUTE) {
        const mid = lo + Math.floor((hi - lo) / (2 * MS_PER_MINUTE)) * MS_PER_MINUTE;
        if (offsetMinutesAt(mid, tzid) === prevOffset) {
            lo = mid;
        }
        else {
            hi = mid;
        }
    }
    return hi;
}
function scanTimezoneTransitions(tzid, startMs, endMs) {
    const startOffset = offsetMinutesAt(startMs, tzid);
    let minOffset = startOffset;
    let prevMs = startMs;
    let prevOffset = startOffset;
    const transitions = [];
    for (let cur = startMs + MS_PER_DAY; cur <= endMs; cur += MS_PER_DAY) {
        const curOffset = offsetMinutesAt(cur, tzid);
        if (curOffset < minOffset) {
            minOffset = curOffset;
        }
        if (curOffset !== prevOffset) {
            const exactMs = bisectTransitionMinute(prevMs, cur, prevOffset, tzid);
            transitions.push({
                fromOffset: prevOffset,
                localStart: floatingWallIcalTime(exactMs, prevOffset),
                toOffset: curOffset,
                tzName: wallPartsInZone(new Date(exactMs), tzid).tzName,
            });
            prevOffset = curOffset;
        }
        prevMs = cur;
    }
    return { minOffset, startOffset, transitions };
}
function buildObservanceSubcomponents(tzid, startMs, minOffset, startOffset, transitions) {
    if (transitions.length === 0) {
        const std = new ICAL.Component("standard");
        std.addPropertyWithValue("dtstart", ICAL.Time.fromData({
            day: 1,
            hour: 0,
            isDate: false,
            minute: 0,
            month: 1,
            second: 0,
            year: 1970,
        }));
        const off = ICAL.UtcOffset.fromString(formatOffset(startOffset));
        std.addPropertyWithValue("tzoffsetfrom", off);
        std.addPropertyWithValue("tzoffsetto", off);
        std.addPropertyWithValue("tzname", wallPartsInZone(new Date(startMs), tzid).tzName);
        return [std];
    }
    const groups = new Map();
    for (const tr of transitions) {
        const kind = tr.toOffset > minOffset ? "daylight" : "standard";
        const key = `${kind}:${tr.fromOffset}:${tr.toOffset}:${tr.tzName}`;
        const existing = groups.get(key);
        if (existing) {
            existing.items.push(tr);
        }
        else {
            groups.set(key, { items: [tr], kind });
        }
    }
    const comps = [];
    for (const { kind, items } of groups.values()) {
        const [first, ...rest] = items;
        if (!first) {
            continue;
        }
        const comp = new ICAL.Component(kind);
        comp.addPropertyWithValue("dtstart", first.localStart);
        comp.addPropertyWithValue("tzoffsetfrom", ICAL.UtcOffset.fromString(formatOffset(first.fromOffset)));
        comp.addPropertyWithValue("tzoffsetto", ICAL.UtcOffset.fromString(formatOffset(first.toOffset)));
        comp.addPropertyWithValue("tzname", first.tzName);
        for (const extra of rest) {
            comp.addPropertyWithValue("rdate", extra.localStart);
        }
        comps.push(comp);
    }
    return comps;
}
/**
 * Ensures `vcalendar` carries an RFC 5545 `VTIMEZONE` for `tzid`. iCloud CalDAV
 * does not advertise `calendar-no-timezone` (RFC 7809), so resources using
 * `TZID=` must embed a matching `VTIMEZONE` component.
 */
export function ensureVTimezone(vcalendar, tzid, refYear = new Date().getUTCFullYear()) {
    if (!tzid || tzid.toUpperCase() === "UTC" || !isValidTimezone(tzid)) {
        return;
    }
    const alreadyPresent = vcalendar
        .getAllSubcomponents("vtimezone")
        .some((sub) => String(sub.getFirstPropertyValue("tzid")) === tzid);
    if (alreadyPresent) {
        return;
    }
    const startMs = Date.UTC(refYear - 2, 0, 1, 0, 0, 0);
    const endMs = Date.UTC(refYear + 10, 11, 31, 23, 0, 0);
    const { minOffset, startOffset, transitions } = scanTimezoneTransitions(tzid, startMs, endMs);
    const vtimezone = new ICAL.Component("vtimezone");
    vtimezone.addPropertyWithValue("tzid", tzid);
    for (const sub of buildObservanceSubcomponents(tzid, startMs, minOffset, startOffset, transitions)) {
        vtimezone.addSubcomponent(sub);
    }
    vcalendar.addSubcomponent(vtimezone);
}
function normalizeIcs(ics) {
    if (!ics.includes("UNTIL=")) {
        return ics;
    }
    const unfolded = ics.replace(/\r?\n[ \t]/gu, "");
    return unfolded.replace(EXTENDED_UNTIL_RE, (_, head, y, mo, d, h, mi, s, z) => h === undefined
        ? `${head}${y}${mo}${d}`
        : `${head}${y}${mo}${d}T${h}${mi}${s}${z ?? ""}`);
}
function cleanIfMatch(etag) {
    const trimmed = etag.trim();
    if (!trimmed || trimmed.startsWith("W/")) {
        return {};
    }
    return { "If-Match": trimmed };
}
async function resolveAndFetchFallback(raw, calendarUrl, uid) {
    const deps = raw.occurrenceDeps?.();
    const resolved = await deps
        ?.resolveHrefByUid?.(calendarUrl, uid)
        .catch(() => undefined);
    if (!(resolved && raw.getIcs)) {
        throw new Error(`Event not found: ${uid}`);
    }
    const absolutize = deps?.absolutize ?? ((u) => u);
    try {
        const fetched = await raw.getIcs(absolutize(resolved));
        return { ...fetched, href: resolved };
    }
    catch (retryError) {
        if (retryError instanceof CalDAVError && retryError.status === 404) {
            throw new Error(`Event not found: ${uid}`, { cause: retryError });
        }
        throw retryError;
    }
}
async function loadRawIcs(client, calendarUrl, uid) {
    const raw = client;
    if (!raw.getIcs) {
        throw new Error("Raw ICS transport unavailable");
    }
    const deps = raw.occurrenceDeps?.();
    const guessedHref = hrefFor(calendarUrl, uid);
    const absolutize = deps?.absolutize ?? ((u) => u);
    try {
        const fetched = await raw.getIcs(absolutize(guessedHref));
        return { ...fetched, href: guessedHref };
    }
    catch (error) {
        if (error instanceof CalDAVError && error.status === 404) {
            return resolveAndFetchFallback(raw, calendarUrl, uid);
        }
        throw error;
    }
}
async function putRawIcs(client, href, ics, etag, isCreate = false) {
    const raw = client;
    if (!raw.mkIcsPut) {
        throw new Error("Raw ICS transport unavailable");
    }
    const deps = raw.occurrenceDeps?.();
    const url = deps ? deps.absolutize(href) : href;
    const headers = isCreate ? { "If-None-Match": "*" } : cleanIfMatch(etag);
    await raw.mkIcsPut(url, ics, headers);
}
function getTzid(prop) {
    if (!prop) {
        return undefined;
    }
    const raw = prop.getParameter("tzid");
    const [first] = Array.isArray(raw) ? raw : [raw];
    return typeof first === "string" && first ? first : undefined;
}
function propertyTimeToDate(prop) {
    const val = prop?.getFirstValue();
    if (!(val instanceof ICAL.Time)) {
        return undefined;
    }
    return fromZonedIcalTime(val, getTzid(prop));
}
function isWholeDayVevent(vevent) {
    const dtstart = vevent.getFirstProperty("dtstart")?.getFirstValue();
    return dtstart instanceof ICAL.Time ? dtstart.isDate : false;
}
function isOverrideVevent(vevent) {
    return vevent.getFirstProperty("recurrence-id") !== null;
}
function parseCalendarComponents(ics) {
    const vcalendar = new ICAL.Component(ICAL.parse(normalizeIcs(ics)));
    const vevents = vcalendar.getAllSubcomponents("vevent");
    const [firstVevent] = vevents;
    const master = vevents.find((v) => !isOverrideVevent(v)) ?? firstVevent;
    if (!master) {
        throw new Error("Calendar resource contains no VEVENT");
    }
    return {
        master,
        overrides: vevents.filter((v) => v !== master && isOverrideVevent(v)),
        vcalendar,
    };
}
function touchComponent(vevent) {
    const now = ICAL.Time.fromJSDate(new Date(), true);
    vevent.removeAllProperties("dtstamp");
    vevent.addPropertyWithValue("dtstamp", now);
    vevent.removeAllProperties("last-modified");
    vevent.addPropertyWithValue("last-modified", now);
    const seqRaw = vevent.getFirstPropertyValue("sequence");
    const seq = typeof seqRaw === "number" ? seqRaw : 0;
    vevent.removeAllProperties("sequence");
    vevent.addPropertyWithValue("sequence", seq + 1);
}
function parseInputDate(isoOrDate) {
    if (DATE_ONLY_RE.test(isoOrDate)) {
        return new Date(`${isoOrDate}T00:00:00.000Z`);
    }
    return new Date(isoOrDate);
}
function extractCalendarDay(isoOrDate, tzid) {
    if (DATE_ONLY_RE.test(isoOrDate)) {
        return isoOrDate;
    }
    const prefix = isoOrDate.slice(0, 10);
    if (!isoOrDate.endsWith("Z") && DATE_ONLY_RE.test(prefix)) {
        return prefix;
    }
    if (tzid && isValidTimezone(tzid)) {
        return dateStringInZone(new Date(isoOrDate), tzid);
    }
    return prefix;
}
function setDateTimeProperty(vevent, name, isoOrDate, wholeDay, tzid) {
    vevent.removeAllProperties(name);
    if (wholeDay) {
        const dayStr = extractCalendarDay(isoOrDate, tzid);
        vevent.addPropertyWithValue(name, ICAL.Time.fromDateString(dayStr));
        return;
    }
    const instant = parseInputDate(isoOrDate);
    if (tzid && tzid.toUpperCase() !== "UTC" && isValidTimezone(tzid)) {
        const prop = vevent.addPropertyWithValue(name, toZonedIcalTime(instant, tzid));
        prop.setParameter("tzid", tzid);
    }
    else {
        vevent.addPropertyWithValue(name, ICAL.Time.fromJSDate(instant, true));
    }
}
function buildMatchingProperty(name, target, masterDtstartProp, vevent) {
    const prop = new ICAL.Property(name, vevent);
    if (target.wholeDay) {
        prop.setValue(ICAL.Time.fromDateString(target.dayStr));
        return prop;
    }
    const masterTzid = getTzid(masterDtstartProp);
    const instant = new Date(target.instantMs);
    if (masterTzid && isValidTimezone(masterTzid)) {
        prop.setValue(toZonedIcalTime(instant, masterTzid));
        prop.setParameter("tzid", masterTzid);
    }
    else {
        prop.setValue(ICAL.Time.fromJSDate(instant, true));
    }
    return prop;
}
function extractIcalTime(val) {
    if (val instanceof ICAL.Time) {
        return val;
    }
    if (val instanceof ICAL.Period) {
        return val.start;
    }
    return undefined;
}
function icalTimeToOccurrence(time, tzid) {
    if (time.isDate) {
        const dayStr = `${time.year}-${pad2(time.month)}-${pad2(time.day)}`;
        const instantMs = Date.UTC(time.year, time.month - 1, time.day);
        return { dayStr, instantMs, iso: dayStr, wholeDay: true };
    }
    const dt = fromZonedIcalTime(time, tzid);
    const dayStr = tzid
        ? dateStringInZone(dt, tzid)
        : dt.toISOString().slice(0, 10);
    return {
        dayStr,
        instantMs: dt.getTime(),
        iso: dt.toISOString(),
        wholeDay: false,
    };
}
function collectPropertyOccurrences(vevent, name) {
    const out = [];
    for (const prop of vevent.getAllProperties(name)) {
        const tzid = getTzid(prop);
        for (const val of prop.getValues()) {
            const time = extractIcalTime(val);
            if (time) {
                out.push(icalTimeToOccurrence(time, tzid));
            }
        }
    }
    return out;
}
function firstPropertyOccurrence(vevent, name) {
    const [first] = collectPropertyOccurrences(vevent, name);
    return first;
}
function expandSeriesThrough(master, horizonMs) {
    const dtstartProp = master.getFirstProperty("dtstart");
    const startVal = dtstartProp?.getFirstValue();
    if (!(startVal instanceof ICAL.Time)) {
        return [];
    }
    const tzid = getTzid(dtstartProp);
    const clone = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    clone.removeAllProperties("exdate");
    const iter = new ICAL.Event(clone).iterator();
    const out = [];
    for (let i = 0; i < MAX_EXPANSION_STEPS; i += 1) {
        const next = iter.next();
        if (!next) {
            break;
        }
        const occ = icalTimeToOccurrence(next, tzid);
        out.push(occ);
        if (occ.instantMs > horizonMs) {
            break;
        }
    }
    return out;
}
function matchDateOnlyOccurrence(generated, rawInput, effectiveTz) {
    const useTz = Boolean(effectiveTz && isValidTimezone(effectiveTz));
    const onDay = generated.filter((occ) => useTz && effectiveTz
        ? dateStringInZone(new Date(occ.instantMs), effectiveTz) === rawInput
        : occ.dayStr === rawInput);
    const [first] = onDay;
    if (onDay.length === 1 && first) {
        return first;
    }
    if (onDay.length > 1) {
        throw new Error(`Multiple occurrences fall on ${rawInput}; pass the exact occurrence start datetime from list-events.`);
    }
    throw new Error(`No occurrence of this recurring series falls on ${rawInput}.`);
}
function resolveOccurrenceTarget(master, overrides, rawInput, fallbackTzid) {
    const dtstartProp = master.getFirstProperty("dtstart");
    const effectiveTz = getTzid(dtstartProp) ?? fallbackTzid;
    if (isWholeDayVevent(master)) {
        const dayStr = extractCalendarDay(rawInput, effectiveTz);
        const [y = 1970, m = 1, d = 1] = dayStr.split("-").map(Number);
        return {
            dayStr,
            instantMs: Date.UTC(y, m - 1, d),
            iso: dayStr,
            wholeDay: true,
        };
    }
    const approxDate = parseInputDate(rawInput);
    const generated = expandSeriesThrough(master, approxDate.getTime() + 3 * MS_PER_DAY);
    for (const ov of overrides) {
        for (const r of collectPropertyOccurrences(ov, "recurrence-id")) {
            if (!generated.some((g) => g.instantMs === r.instantMs)) {
                generated.push(r);
            }
        }
    }
    if (DATE_ONLY_RE.test(rawInput)) {
        return matchDateOnlyOccurrence(generated, rawInput, effectiveTz);
    }
    const targetMs = approxDate.getTime();
    const exact = generated.find((occ) => occ.instantMs === targetMs);
    if (exact) {
        return exact;
    }
    const near = generated.filter((occ) => Math.abs(occ.instantMs - targetMs) <= SNAP_WINDOW_MS);
    const [snapped] = near;
    if (near.length === 1 && snapped) {
        return snapped;
    }
    const dayStr = effectiveTz && isValidTimezone(effectiveTz)
        ? dateStringInZone(approxDate, effectiveTz)
        : approxDate.toISOString().slice(0, 10);
    return {
        dayStr,
        instantMs: targetMs,
        iso: approxDate.toISOString(),
        wholeDay: false,
    };
}
function buildIcalRecur(rule, wholeDay, tzid) {
    let until;
    if (rule.until !== undefined) {
        until = wholeDay
            ? ICAL.Time.fromDateString(extractCalendarDay(rule.until, tzid))
            : ICAL.Time.fromJSDate(parseInputDate(rule.until), true);
    }
    return ICAL.Recur.fromData({
        ...(rule.freq !== undefined && { freq: rule.freq }),
        ...(rule.interval !== undefined && { interval: rule.interval }),
        ...(rule.count !== undefined && { count: rule.count }),
        ...(until !== undefined && { until }),
        ...(rule.byday !== undefined && { byday: rule.byday }),
        ...(rule.bymonthday !== undefined && { bymonthday: rule.bymonthday }),
        ...(rule.bymonth !== undefined && { bymonth: rule.bymonth }),
    });
}
function setTextProperty(vevent, name, value) {
    if (value === undefined) {
        return;
    }
    vevent.removeAllProperties(name);
    if (name === "location") {
        vevent.removeAllProperties("x-apple-structured-location");
    }
    if (value !== "") {
        vevent.addPropertyWithValue(name, value);
    }
}
function addInclusiveWholeDayEnd(dayStr) {
    const [y = 1970, m = 1, d = 1] = dayStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function inclusiveEndDayFromExclusive(exclusiveEndProp, startDayStr) {
    const val = exclusiveEndProp?.getFirstValue();
    if (!(val instanceof ICAL.Time && val.isDate)) {
        return startDayStr;
    }
    const dt = new Date(Date.UTC(val.year, val.month - 1, val.day - 1));
    const endDay = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    return endDay < startDayStr ? startDayStr : endDay;
}
function setWholeDaySpan(vevent, startDay, inclusiveEndDay) {
    const lastDay = inclusiveEndDay < startDay ? startDay : inclusiveEndDay;
    vevent.removeAllProperties("dtstart");
    vevent.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(startDay));
    vevent.removeAllProperties("dtend");
    vevent.addPropertyWithValue("dtend", ICAL.Time.fromDateString(addInclusiveWholeDayEnd(lastDay)));
}
export async function createEventIcs(client, calendarUrl, input) {
    const uid = randomUUID();
    const href = hrefFor(calendarUrl, uid);
    const wholeDay = Boolean(input.wholeDay);
    const tzid = wholeDay ? undefined : (input.timezone ?? defaultTimezone());
    const vcalendar = new ICAL.Component(["vcalendar", [], []]);
    vcalendar.addPropertyWithValue("version", "2.0");
    vcalendar.addPropertyWithValue("prodid", "-//LeaMonde//caldav-mcp//EN");
    vcalendar.addPropertyWithValue("calscale", "GREGORIAN");
    if (tzid) {
        ensureVTimezone(vcalendar, tzid, parseInputDate(input.start).getUTCFullYear());
    }
    const vevent = new ICAL.Component("vevent");
    vevent.addPropertyWithValue("uid", uid);
    const now = ICAL.Time.fromJSDate(new Date(), true);
    vevent.addPropertyWithValue("dtstamp", now);
    vevent.addPropertyWithValue("created", now);
    vevent.addPropertyWithValue("sequence", 0);
    if (wholeDay) {
        setWholeDaySpan(vevent, extractCalendarDay(input.start, tzid), extractCalendarDay(input.end, tzid));
    }
    else {
        setDateTimeProperty(vevent, "dtstart", input.start, false, tzid);
        setDateTimeProperty(vevent, "dtend", input.end, false, tzid);
    }
    setTextProperty(vevent, "summary", input.summary);
    setTextProperty(vevent, "description", input.description);
    setTextProperty(vevent, "location", input.location);
    if (input.recurrenceRule !== undefined) {
        vevent.addPropertyWithValue("rrule", buildIcalRecur(input.recurrenceRule, wholeDay, tzid));
    }
    vcalendar.addSubcomponent(vevent);
    await putRawIcs(client, href, vcalendar.toString(), "", true);
    return uid;
}
function truncateMasterBefore(vcalendar, master, overrides, earliest, wholeDay) {
    const dtstartProp = master.getFirstProperty("dtstart");
    const rruleProp = master.getFirstProperty("rrule");
    if (rruleProp) {
        const recur = rruleProp.getFirstValue();
        recur.count = null;
        if (wholeDay) {
            const prev = new Date(earliest.instantMs - MS_PER_DAY);
            const prevDay = `${prev.getUTCFullYear()}-${pad2(prev.getUTCMonth() + 1)}-${pad2(prev.getUTCDate())}`;
            recur.until = ICAL.Time.fromDateString(prevDay);
        }
        else {
            recur.until = ICAL.Time.fromJSDate(new Date(earliest.instantMs - 1000), true);
        }
        rruleProp.setValue(recur);
    }
    for (const ov of overrides) {
        const recId = firstPropertyOccurrence(ov, "recurrence-id");
        if (recId && recId.instantMs >= earliest.instantMs) {
            vcalendar.removeSubcomponent(ov);
        }
    }
    const keptExdates = collectPropertyOccurrences(master, "exdate").filter((ex) => ex.instantMs < earliest.instantMs);
    master.removeAllProperties("exdate");
    for (const ex of keptExdates) {
        master.addProperty(buildMatchingProperty("exdate", ex, dtstartProp, master));
    }
}
function appendExdatesForTargets(vcalendar, master, overrides, targets, dtstartProp) {
    const existingMs = new Set(collectPropertyOccurrences(master, "exdate").map((e) => e.instantMs));
    const added = [];
    for (const target of targets) {
        for (const ov of overrides) {
            const recId = firstPropertyOccurrence(ov, "recurrence-id");
            if (recId && recId.instantMs === target.instantMs) {
                vcalendar.removeSubcomponent(ov);
            }
        }
        if (!existingMs.has(target.instantMs)) {
            master.addProperty(buildMatchingProperty("exdate", target, dtstartProp, master));
            existingMs.add(target.instantMs);
        }
        added.push(target.iso);
    }
    return added;
}
async function deleteResourceByHrefOrUid(client, calendarUrl, uid, href, etag) {
    const rawClient = client;
    const deps = rawClient.occurrenceDeps?.();
    if (deps) {
        await deps.deleteResource(deps.absolutize(href), etag);
        return;
    }
    await client.deleteEvent(calendarUrl, uid, etag);
}
export async function skipOrTruncateOccurrences(client, calendarUrl, uid, rawOccurrenceDates, scope = "this") {
    const { href, ics, etag } = await loadRawIcs(client, calendarUrl, uid);
    const { vcalendar, master, overrides } = parseCalendarComponents(ics);
    if (master.getFirstProperty("rrule") === null &&
        master.getFirstProperty("rdate") === null) {
        throw new Error("This event is not a recurring series; call delete-event without occurrenceDates to delete it.");
    }
    const fallbackTz = defaultTimezone();
    const targets = rawOccurrenceDates
        .map((raw) => resolveOccurrenceTarget(master, overrides, raw, fallbackTz))
        .sort((a, b) => a.instantMs - b.instantMs);
    const [earliest] = targets;
    if (!earliest) {
        throw new Error("At least one occurrence date is required.");
    }
    if (scope === "thisAndFuture") {
        const masterStart = firstPropertyOccurrence(master, "dtstart");
        if (masterStart && earliest.instantMs <= masterStart.instantMs) {
            await deleteResourceByHrefOrUid(client, calendarUrl, uid, href, etag);
            return {
                seriesDeleted: true,
                skippedDates: [],
                truncatedBefore: earliest.iso,
            };
        }
        truncateMasterBefore(vcalendar, master, overrides, earliest, isWholeDayVevent(master));
        touchComponent(master);
        await putRawIcs(client, href, vcalendar.toString(), etag);
        return {
            seriesDeleted: false,
            skippedDates: [],
            truncatedBefore: earliest.iso,
        };
    }
    const added = appendExdatesForTargets(vcalendar, master, overrides, targets, master.getFirstProperty("dtstart"));
    touchComponent(master);
    await putRawIcs(client, href, vcalendar.toString(), etag);
    return { seriesDeleted: false, skippedDates: added };
}
function createOverrideFromMaster(master, target, effectiveTz) {
    const override = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    for (const p of ["rrule", "exdate", "rdate", "recurrence-id"]) {
        override.removeAllProperties(p);
    }
    const dtstartProp = master.getFirstProperty("dtstart");
    override.addProperty(buildMatchingProperty("recurrence-id", target, dtstartProp, override));
    const masterStart = propertyTimeToDate(dtstartProp);
    const masterEnd = propertyTimeToDate(master.getFirstProperty("dtend"));
    const durationMs = masterStart && masterEnd
        ? Math.max(0, masterEnd.getTime() - masterStart.getTime())
        : 0;
    if (isWholeDayVevent(master)) {
        const daysSpan = Math.max(1, Math.round(durationMs / MS_PER_DAY));
        const lastDt = new Date(target.instantMs + (daysSpan - 1) * MS_PER_DAY);
        const lastDay = `${lastDt.getUTCFullYear()}-${pad2(lastDt.getUTCMonth() + 1)}-${pad2(lastDt.getUTCDate())}`;
        setWholeDaySpan(override, target.dayStr, lastDay);
    }
    else {
        setDateTimeProperty(override, "dtstart", new Date(target.instantMs).toISOString(), false, effectiveTz);
        setDateTimeProperty(override, "dtend", new Date(target.instantMs + durationMs).toISOString(), false, effectiveTz);
    }
    return override;
}
function removeExdateForTarget(master, targetMs, dtstartProp) {
    const existing = collectPropertyOccurrences(master, "exdate");
    const kept = existing.filter((ex) => ex.instantMs !== targetMs);
    if (kept.length === existing.length) {
        return;
    }
    master.removeAllProperties("exdate");
    for (const ex of kept) {
        master.addProperty(buildMatchingProperty("exdate", ex, dtstartProp, master));
    }
    touchComponent(master);
}
function applyComponentDates(component, wasWholeDay, effectiveWholeDay, effectiveTz, fallbackDay, changes) {
    if (changes.start === undefined &&
        changes.end === undefined &&
        changes.wholeDay === undefined) {
        return;
    }
    if (!effectiveWholeDay) {
        if (changes.start !== undefined) {
            setDateTimeProperty(component, "dtstart", changes.start, false, effectiveTz);
        }
        if (changes.end !== undefined) {
            setDateTimeProperty(component, "dtend", changes.end, false, effectiveTz);
        }
        return;
    }
    const startDay = changes.start
        ? extractCalendarDay(changes.start, effectiveTz)
        : fallbackDay;
    let defaultEndDay = startDay;
    if (wasWholeDay) {
        defaultEndDay = inclusiveEndDayFromExclusive(component.getFirstProperty("dtend"), startDay);
    }
    else {
        const curEnd = propertyTimeToDate(component.getFirstProperty("dtend"));
        if (curEnd) {
            defaultEndDay = localDateString(new Date(curEnd.getTime() - 1));
        }
    }
    const inclusiveEnd = changes.end
        ? extractCalendarDay(changes.end, effectiveTz)
        : defaultEndDay;
    setWholeDaySpan(component, startDay, inclusiveEnd);
}
export async function overrideSingleOccurrence(client, calendarUrl, uid, rawOccurrenceDate, changes) {
    const { href, ics, etag } = await loadRawIcs(client, calendarUrl, uid);
    const { vcalendar, master, overrides } = parseCalendarComponents(ics);
    if (master.getFirstProperty("rrule") === null &&
        master.getFirstProperty("rdate") === null) {
        throw new Error("This event is not a recurring series; omit occurrenceDate to update it.");
    }
    const dtstartProp = master.getFirstProperty("dtstart");
    const target = resolveOccurrenceTarget(master, overrides, rawOccurrenceDate, changes.timezone ?? defaultTimezone());
    const effectiveWholeDay = changes.wholeDay ?? isWholeDayVevent(master);
    const effectiveTz = effectiveWholeDay
        ? undefined
        : (changes.timezone ?? getTzid(dtstartProp) ?? defaultTimezone());
    if (effectiveTz) {
        ensureVTimezone(vcalendar, effectiveTz, new Date(target.instantMs).getUTCFullYear());
    }
    let override = overrides.find((ov) => firstPropertyOccurrence(ov, "recurrence-id")?.instantMs ===
        target.instantMs);
    if (!override) {
        override = createOverrideFromMaster(master, target, effectiveTz);
        vcalendar.addSubcomponent(override);
    }
    removeExdateForTarget(master, target.instantMs, dtstartProp);
    const curStartDay = firstPropertyOccurrence(override, "dtstart")?.dayStr ?? target.dayStr;
    applyComponentDates(override, isWholeDayVevent(override), effectiveWholeDay, effectiveTz, curStartDay, changes);
    setTextProperty(override, "summary", changes.summary);
    setTextProperty(override, "description", changes.description);
    setTextProperty(override, "location", changes.location);
    touchComponent(override);
    await putRawIcs(client, href, vcalendar.toString(), etag);
    return uid;
}
function defaultMasterStartDay(master, masterWholeDay) {
    if (masterWholeDay) {
        return firstPropertyOccurrence(master, "dtstart")?.dayStr ?? "1970-01-01";
    }
    const curStart = propertyTimeToDate(master.getFirstProperty("dtstart"));
    return curStart ? localDateString(curStart) : "1970-01-01";
}
export async function updateMasterEventIcs(client, calendarUrl, uid, changes) {
    const { href, ics, etag } = await loadRawIcs(client, calendarUrl, uid);
    const { vcalendar, master, overrides } = parseCalendarComponents(ics);
    const masterWholeDay = isWholeDayVevent(master);
    const effectiveWholeDay = changes.wholeDay ?? masterWholeDay;
    const dtstartProp = master.getFirstProperty("dtstart");
    const effectiveTz = effectiveWholeDay
        ? undefined
        : (changes.timezone ?? getTzid(dtstartProp) ?? defaultTimezone());
    if (effectiveTz) {
        const refDate = changes.start
            ? parseInputDate(changes.start)
            : (propertyTimeToDate(dtstartProp) ?? new Date());
        ensureVTimezone(vcalendar, effectiveTz, refDate.getUTCFullYear());
    }
    applyComponentDates(master, masterWholeDay, effectiveWholeDay, effectiveTz, defaultMasterStartDay(master, masterWholeDay), changes);
    setTextProperty(master, "summary", changes.summary);
    setTextProperty(master, "description", changes.description);
    setTextProperty(master, "location", changes.location);
    if (changes.recurrenceRule !== undefined) {
        master.removeAllProperties("rrule");
        master.addPropertyWithValue("rrule", buildIcalRecur(changes.recurrenceRule, effectiveWholeDay, effectiveTz));
    }
    if (changes.excludeDates && changes.excludeDates.length > 0) {
        const targets = changes.excludeDates.map((raw) => resolveOccurrenceTarget(master, overrides, raw, effectiveTz ?? defaultTimezone()));
        appendExdatesForTargets(vcalendar, master, overrides, targets, master.getFirstProperty("dtstart"));
    }
    touchComponent(master);
    await putRawIcs(client, href, vcalendar.toString(), etag);
    return uid;
}
function serializeIcalRecur(rruleVal, tzid) {
    if (!(rruleVal instanceof ICAL.Recur)) {
        return undefined;
    }
    const parts = rruleVal.parts;
    let untilStr;
    if (rruleVal.until) {
        untilStr = rruleVal.until.isDate
            ? `${rruleVal.until.year}-${pad2(rruleVal.until.month)}-${pad2(rruleVal.until.day)}`
            : fromZonedIcalTime(rruleVal.until, tzid).toISOString();
    }
    return {
        ...(rruleVal.freq ? { freq: rruleVal.freq } : {}),
        ...(rruleVal.interval ? { interval: rruleVal.interval } : {}),
        ...(rruleVal.count ? { count: rruleVal.count } : {}),
        ...(untilStr ? { until: untilStr } : {}),
        ...(parts.BYDAY?.length ? { byday: [...parts.BYDAY] } : {}),
        ...(parts.BYMONTHDAY?.length ? { bymonthday: [...parts.BYMONTHDAY] } : {}),
        ...(parts.BYMONTH?.length ? { bymonth: [...parts.BYMONTH] } : {}),
    };
}
function serializeParsedMaster(uid, master, overridesCount) {
    const wholeDay = isWholeDayVevent(master);
    const dtstartProp = master.getFirstProperty("dtstart");
    const dtendProp = master.getFirstProperty("dtend");
    const tzid = getTzid(dtstartProp);
    const startOcc = firstPropertyOccurrence(master, "dtstart");
    const endOcc = firstPropertyOccurrence(master, "dtend");
    const endVal = endOcc?.iso ?? propertyTimeToDate(dtendProp)?.toISOString();
    const recurrenceRule = serializeIcalRecur(master.getFirstProperty("rrule")?.getFirstValue(), tzid);
    const exdates = collectPropertyOccurrences(master, "exdate").map((e) => e.iso);
    const description = master.getFirstPropertyValue("description");
    const location = master.getFirstPropertyValue("location");
    return {
        summary: String(master.getFirstPropertyValue("summary") ?? ""),
        uid,
        ...(startOcc ? { start: startOcc.iso } : {}),
        ...(endVal ? { end: endVal } : {}),
        ...(wholeDay ? { wholeDay: true } : {}),
        ...(tzid ? { timezone: tzid } : {}),
        ...(description ? { description: String(description) } : {}),
        ...(location ? { location: String(location) } : {}),
        ...(recurrenceRule ? { recurrenceRule } : {}),
        ...(exdates.length > 0 ? { exdates } : {}),
        ...(overridesCount > 0 ? { overridesCount } : {}),
    };
}
export async function inspectMasterEvent(client, calendarUrl, uid) {
    if (hasRawIcsAccess(client)) {
        try {
            const { ics } = await loadRawIcs(client, calendarUrl, uid);
            const { master, overrides } = parseCalendarComponents(ics);
            return serializeParsedMaster(uid, master, overrides.length);
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.startsWith("Event not found:")) {
                return null;
            }
            throw error;
        }
    }
    const [ev] = await client.getEventsByHref(calendarUrl, [
        hrefFor(calendarUrl, uid),
    ]);
    if (!ev) {
        return null;
    }
    return {
        end: ev.wholeDay ? localDateString(ev.end) : ev.end.toISOString(),
        start: ev.wholeDay ? localDateString(ev.start) : ev.start.toISOString(),
        summary: ev.summary,
        uid: ev.uid,
        ...(ev.wholeDay ? { wholeDay: true } : {}),
        ...(ev.startTzid ? { timezone: ev.startTzid } : {}),
        ...(ev.description ? { description: ev.description } : {}),
        ...(ev.location ? { location: ev.location } : {}),
        ...(ev.recurrenceRule ? { recurrenceRule: ev.recurrenceRule } : {}),
        ...(ev.exdates?.length
            ? {
                exdates: ev.exdates.map((d) => ev.wholeDay ? localDateString(d) : d.toISOString()),
            }
            : {}),
    };
}
