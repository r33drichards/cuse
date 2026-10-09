import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/commands.ts";
import { parseScheduleCommand } from "../src/schedule-commands.ts";

test("schedule syntax preserves prompts and uses explicit UTC default", () => {
 assert.deepEqual(parseCommand(",schedule cron 0 9 * * * :: Check the dashboard :: summarize"), {kind:"schedule",request:{action:"create",timing:{kind:"cron",expression:"0 9 * * *",timeZone:"UTC"},prompt:"Check the dashboard :: summarize"}});
 assert.deepEqual(parseScheduleCommand("cron America/Los_Angeles 0 9 * * 1-5 :: Report"),{action:"create",timing:{kind:"cron",expression:"0 9 * * 1-5",timeZone:"America/Los_Angeles"},prompt:"Report"});
 assert.deepEqual(parseScheduleCommand("every 30m :: Check"),{action:"create",timing:{kind:"interval",everyMs:1_800_000},prompt:"Check"});
});
test("relative one-shots stay unresolved until durable first creation", () => {
 assert.deepEqual(parseScheduleCommand("once 10m :: Check"),{action:"create",timing:{kind:"delay",afterMs:600_000},prompt:"Check"});
 assert.deepEqual(parseScheduleCommand("once 2030-01-01T09:00:00-08:00 :: Check"),{action:"create",timing:{kind:"once",at:Date.parse("2030-01-01T09:00:00-08:00")},prompt:"Check"});
});
test("schedule commands reject ambiguous dates, missing prompts and malformed durations", () => {
 for(const text of ["once tomorrow :: Check","once 2030-01-01T09:00 :: Check","every -1m :: Check","every 0m :: Check","every 2.5m :: Check","cron 0 9 * * :: Check","every 1h :: ","pause id extra"]) assert.equal(parseScheduleCommand(text),undefined,text);
 assert.equal(parseCommand(",schedule nonsense")?.kind,"error");
 assert.deepEqual(parseCommand(",schedule"),{kind:"schedule",request:{action:"list"}});
 for(const action of ["pause","resume","delete"]) assert.deepEqual(parseScheduleCommand(`${action} job-1`),{action,id:"job-1"});
});
