import test from "node:test";
import assert from "node:assert/strict";
import { authConfigurationError, createSessionToken, verifyAdminPassword, verifySessionToken } from "../src/lib/auth";
const original = { AUTH_REQUIRED: process.env.AUTH_REQUIRED, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, SESSION_SECRET: process.env.SESSION_SECRET };
test.afterEach(() => { for (const [key,value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; });
test("authentication can remain disabled for local development", () => { delete process.env.AUTH_REQUIRED; delete process.env.ADMIN_PASSWORD; delete process.env.SESSION_SECRET; assert.equal(authConfigurationError(), null); });
test("required authentication rejects weak configuration", () => { process.env.AUTH_REQUIRED="true"; process.env.ADMIN_PASSWORD="short"; process.env.SESSION_SECRET="short"; assert.match(authConfigurationError()!, /ADMIN_PASSWORD/); });
test("signed session validates and detects tampering or expiry", async () => { process.env.AUTH_REQUIRED="true"; process.env.ADMIN_PASSWORD="a-strong-admin-password"; process.env.SESSION_SECRET="0123456789abcdef0123456789abcdef"; const now=1_800_000_000_000; const token=await createSessionToken(now); assert.equal(await verifySessionToken(token,now),true); assert.equal(await verifySessionToken(token+"x",now),false); assert.equal(await verifySessionToken(token,now+9*60*60*1000),false); });
test("admin password comparison accepts only exact value", () => { process.env.ADMIN_PASSWORD="a-strong-admin-password"; assert.equal(verifyAdminPassword("a-strong-admin-password"),true); assert.equal(verifyAdminPassword("a-strong-admin-password!"),false); });
