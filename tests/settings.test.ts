import test from "node:test";import assert from "node:assert/strict";import { defaultShadowSettings,shadowSettingsSchema } from "../src/lib/settings";
test("default shadow settings are valid",()=>assert.equal(shadowSettingsSchema.safeParse(defaultShadowSettings()).success,true));
test("exposure cannot be smaller than entry size",()=>{const value={...defaultShadowSettings(),entryLamports:100_000_000,maxExposureLamports:50_000_000};assert.equal(shadowSettingsSchema.safeParse(value).success,false);});
test("stop loss must remain negative",()=>{const value={...defaultShadowSettings(),stopLossBps:100};assert.equal(shadowSettingsSchema.safeParse(value).success,false);});
test("daily loss limit must remain negative",()=>{const value={...defaultShadowSettings(),dailyLossLimitLamports:0};assert.equal(shadowSettingsSchema.safeParse(value).success,false);});
