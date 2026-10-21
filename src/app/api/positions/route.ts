import { NextResponse } from "next/server";
import { listShadowPositions } from "@/db/repository";
export const runtime = "nodejs";
export async function GET() { return NextResponse.json({ positions: await listShadowPositions() }); }
