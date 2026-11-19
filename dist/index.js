#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CalDAVClient } from "ts-caldav";
import { parseHttpConfig } from "./http-config.js";
import { createServer } from "./server.js";
function listeningUrl(server) {
    const { address, family, port } = server.address();
    const host = family === "IPv6" ? `[${address}]` : address;
    return `http://${host}:${port}/mcp`;
}
function shutDownOnSignals(server) {
    const shutdown = () => {
        server.close(() => process.exit(0));
        // closeIdleConnections only exists from Node 18.2; engines allows 18.0.
        server.closeIdleConnections?.();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
async function main() {
    let httpConfig;
    if (process.argv.includes("--http")) {
        try {
            httpConfig = parseHttpConfig(process.env);
        }
        catch (error) {
            console.error(error.message);
            process.exit(1);
            return;
        }
    }
    const client = await CalDAVClient.create({
        auth: {
            password: process.env.CALDAV_PASSWORD || "",
            type: "basic",
            username: process.env.CALDAV_USERNAME || "",
        },
        baseUrl: process.env.CALDAV_BASE_URL || "",
    });
    // Test connection on startup
    try {
        await client.getCalendars();
    }
    catch (error) {
        console.error("❌ Failed to connect to CalDAV server:", error);
        process.exit(1);
    }
    if (httpConfig) {
        // Imported lazily so stdio mode never loads the HTTP stack.
        const { startHttpServer } = await import("./http-server.js");
        const server = await startHttpServer(httpConfig, () => createServer(client));
        // stdout is not reserved in HTTP mode, but keep logs on stderr like stdio.
        console.error(`caldav-mcp listening on ${listeningUrl(server)}`);
        shutDownOnSignals(server);
        return;
    }
    // Start receiving messages on stdin and sending messages on stdout
    await createServer(client).connect(new StdioServerTransport());
}
const MAX_CAUSE_DEPTH = 5;
/** undici's AggregateError for a refused multi-address connect has no message. */
function messageOf(error) {
    if (error.message) {
        return error.message;
    }
    const { code } = error;
    return typeof code === "string" ? code : error.name;
}
/**
 * One line for a startup error, with its cause chain: ts-caldav and fetch
 * keep the actual network reason (ENOTFOUND, TLS errors) only in `cause`.
 */
function describeError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const causes = [];
    let { cause } = error;
    while (cause instanceof Error && causes.length < MAX_CAUSE_DEPTH) {
        causes.push(messageOf(cause));
        ({ cause } = cause);
    }
    return causes.length > 0
        ? `${error.message} (${causes.join(": ")})`
        : error.message;
}
main().catch((error) => {
    // e.g. EADDRINUSE or an unreachable CalDAV server: one readable line
    // instead of an unhandled rejection.
    console.error(`caldav-mcp: failed to start: ${describeError(error)}`);
    process.exit(1);
});
