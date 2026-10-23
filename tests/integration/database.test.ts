import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../src/db/client";
import { getDatabaseHealth, getShadowSettings, getTradingControls, updateShadowSettings, updateTradingControls } from "../../src/db/repository";
import { riskAssessments, runtimeSettings, signals, tokens } from "../../src/db/schema";
config({path:".env.local"});

test("database health and runtime controls persist safely",async()=>{const health=await getDatabaseHealth();assert.equal(health.connected,true);const initial=await getTradingControls();try{await updateTradingControls(!initial.entriesPaused,"integration test",false);const changed=await getTradingControls();assert.equal(changed.entriesPaused,!initial.entriesPaused);}finally{await updateTradingControls(initial.entriesPaused,initial.reason??"restored after integration test",initial.haltAll);}const restored=await getTradingControls();assert.equal(restored.entriesPaused,initial.entriesPaused);assert.equal(restored.haltAll,initial.haltAll);});

test("signal idempotency constraint prevents duplicates and transaction rolls back",async()=>{const db=getDatabase(),mint=`test-${randomUUID()}`,key=`test-signal-${randomUUID()}`,rollback=new Error("ROLLBACK_TEST");await assert.rejects(db.transaction(async tx=>{const[token]=await tx.insert(tokens).values({mint,symbol:"TEST",name:"Integration Test",status:"eligible"}).returning({id:tokens.id});const[risk]=await tx.insert(riskAssessments).values({tokenId:token.id,version:1,status:"eligible",score:0,checks:[]}).returning({id:riskAssessments.id});const[first]=await tx.insert(signals).values({tokenId:token.id,riskAssessmentId:risk.id,strategyVersion:"test",idempotencyKey:key,score:"1",payload:{}}).returning({id:signals.id});const second=await tx.insert(signals).values({tokenId:token.id,riskAssessmentId:risk.id,strategyVersion:"test",idempotencyKey:key,score:"1",payload:{}}).onConflictDoNothing().returning({id:signals.id});assert.ok(first.id);assert.equal(second.length,0);throw rollback;}),error=>error===rollback);const leftover=await db.select({id:tokens.id}).from(tokens).where(eq(tokens.mint,mint));assert.equal(leftover.length,0);});

test("runtime settings schema exists after migrations",async()=>{const rows=await getDatabase().select().from(runtimeSettings).limit(1);assert.ok(Array.isArray(rows));});
test("shadow settings persist and are restored",async()=>{const initial=await getShadowSettings();try{await updateShadowSettings({...initial,minSignalScore:initial.minSignalScore===99?98:99});const changed=await getShadowSettings();assert.notEqual(changed.minSignalScore,initial.minSignalScore);}finally{await updateShadowSettings(initial);}assert.deepEqual(await getShadowSettings(),initial);});
