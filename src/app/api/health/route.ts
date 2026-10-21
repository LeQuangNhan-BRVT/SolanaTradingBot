import { NextResponse } from "next/server";import { sendAlertOnce } from "@/lib/alerts";
import { getSystemHealth } from "@/lib/health";
export const runtime="nodejs";
export async function GET(){const health=await getSystemHealth();if(health.status!=="healthy")void sendAlertOnce("system-health-degraded",15*60_000,{type:"system.health.degraded",severity:"critical",title:"Aegis system degraded",message:Object.entries(health.checks).filter(([,ok])=>!ok).map(([name])=>name).join(", "),data:{checks:health.checks}});return NextResponse.json(health,{status:health.status==="healthy"?200:503});}
