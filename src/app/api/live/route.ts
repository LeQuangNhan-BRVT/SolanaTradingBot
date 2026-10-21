import { NextResponse } from "next/server";export function GET(){return NextResponse.json({status:"live",at:new Date().toISOString()});}
