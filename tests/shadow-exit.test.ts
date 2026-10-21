import test from "node:test";
import assert from "node:assert/strict";
import { decideShadowExit } from "../src/lib/shadow";
const base={tokenStatus:"eligible",pnlBps:0,ageMinutes:10,stopLossBps:-1500,takeProfitBps:3000,maxAgeMinutes:360};
test("risk exit has highest priority",()=>assert.equal(decideShadowExit({...base,tokenStatus:"rejected",pnlBps:5000}),"risk_exit"));
test("stop loss triggers at boundary",()=>assert.equal(decideShadowExit({...base,pnlBps:-1500}),"stop_loss"));
test("take profit triggers at boundary",()=>assert.equal(decideShadowExit({...base,pnlBps:3000}),"take_profit"));
test("time stop triggers at boundary",()=>assert.equal(decideShadowExit({...base,ageMinutes:360}),"time_stop"));
test("healthy position stays open",()=>assert.equal(decideShadowExit(base),null));
