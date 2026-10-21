import test from "node:test";
import assert from "node:assert/strict";
import { assessCandidate } from "../src/lib/risk-engine";
import type { Candidate } from "../src/lib/types";
const candidate=(overrides:Partial<Candidate>={}):Candidate=>({mint:"mint",symbol:"T",name:"Token",launchpad:"Pump.fun",migratedHours:5,riskScore:0,bundlePct:2,clusterPct:1,liquidityUsd:100_000,volume1hUsd:80_000,priceChange1h:10,status:"monitoring",...overrides});
test("eligible only when every hard gate passes",()=>{const result=assessCandidate(candidate(),null,null);assert.equal(result.status,"eligible");assert.equal(result.riskScore,0);assert.ok(result.checks.every(x=>x.status==="pass"));});
test("unknown critical data remains fail-closed",()=>{const result=assessCandidate(candidate({bundlePct:null,clusterPct:null}),null,null);assert.equal(result.status,"monitoring");assert.equal(result.riskScore,20);});
test("active authority and low liquidity reject token",()=>{const result=assessCandidate(candidate({liquidityUsd:10_000}),"authority",null);assert.equal(result.status,"rejected");assert.equal(result.riskScore,60);});
test("migration boundary is inclusive at four hours",()=>{assert.equal(assessCandidate(candidate({migratedHours:4}),null,null).status,"eligible");assert.equal(assessCandidate(candidate({migratedHours:3.99}),null,null).status,"rejected");});
