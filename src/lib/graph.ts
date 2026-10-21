import { Connection, PublicKey } from "@solana/web3.js";
const ATA_PROGRAM=new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export type FundingEdge={from:string;to:string;signature:string;slot:bigint;blockTime:Date;lamports:string};
export type HolderNode={rank:number;tokenAccount:string;owner:string;amountRaw:string;percentage:number;excluded:boolean;exclusionReason:string|null;funding:FundingEdge|null};
export type HolderGraph={slot:bigint;supplyRaw:string;holders:HolderNode[];creatorClusterPct:number|null;creatorFunder:string|null;fundingComplete:boolean};
// Returns null only when the lookup succeeded and no incoming SOL transfer was found; transport errors throw.
async function firstFunding(wallet:string,key:string):Promise<FundingEdge|null>{
 const response=await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,{method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(30_000),body:JSON.stringify({jsonrpc:"2.0",id:"aegis-funding",method:"getTransactionsForAddress",params:[wallet,{transactionDetails:"full",encoding:"jsonParsed",maxSupportedTransactionVersion:0,sortOrder:"asc",limit:50,filters:{status:"succeeded"}}]})});if(!response.ok)throw new Error(`Helius funding history HTTP ${response.status}`);
 const payload=await response.json() as {error?:{message?:string};result?:{data?:Array<Record<string,unknown>>}};if(payload.error)throw new Error(payload.error.message??"Helius funding history error");
 for(const record of payload.result?.data??[]){const tx=record.transaction as {signatures?:string[];message?:{instructions?:unknown[]}}|undefined,meta=record.meta as {innerInstructions?:Array<{instructions?:unknown[]}>}|undefined;for(const raw of [...(tx?.message?.instructions??[]),...(meta?.innerInstructions?.flatMap(x=>x.instructions??[])??[])]){if(!raw||typeof raw!=="object"||!("parsed" in raw))continue;const parsed=(raw as {parsed?:{type?:string;info?:Record<string,unknown>}}).parsed;if(parsed?.type!=="transfer"||parsed.info?.destination!==wallet||typeof parsed.info.source!=="string")continue;const amount=parsed.info.lamports;if(typeof amount!=="number"&&typeof amount!=="string")continue;const signature=tx?.signatures?.[0],slot=record.slot,blockTime=record.blockTime;if(signature&&typeof slot==="number"&&typeof blockTime==="number")return{from:parsed.info.source,to:wallet,signature,slot:BigInt(slot),blockTime:new Date(blockTime*1000),lamports:String(amount)}}}return null;
}
// Fail-closed: without complete funding data or a known creator funder the cluster is unknown, never 0%.
export function computeCreatorCluster(holders:HolderNode[],creatorAddresses:string[],creatorFunder:string|null,fundingComplete:boolean):number|null{
 if(!fundingComplete||!creatorFunder)return null;
 const cluster=new Set(creatorAddresses);for(const node of holders)if(node.funding?.from===creatorFunder)cluster.add(node.owner);
 return holders.filter(x=>!x.excluded&&cluster.has(x.owner)).reduce((sum,x)=>sum+x.percentage,0);
}
export async function inspectHolderGraph(mintAddress:string,tokenProgramAddress:string,poolAddress:string|null,creatorAddresses:string[]):Promise<HolderGraph>{
 const key=process.env.HELIUS_API_KEY,rpcUrl=key?`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`:(process.env.SOLANA_RPC_URL??"https://api.mainnet-beta.solana.com");
 const connection=new Connection(rpcUrl,"confirmed"),mint=new PublicKey(mintAddress);
 const [largest,supply]=await Promise.all([connection.getTokenLargestAccounts(mint,"confirmed"),connection.getTokenSupply(mint,"confirmed")]);
 const accounts=await connection.getMultipleParsedAccounts(largest.value.map(x=>x.address),{commitment:"confirmed"});
 let poolVault:string|null=null;if(poolAddress)poolVault=PublicKey.findProgramAddressSync([new PublicKey(poolAddress).toBuffer(),new PublicKey(tokenProgramAddress).toBuffer(),mint.toBuffer()],ATA_PROGRAM)[0].toBase58();
 const total=BigInt(supply.value.amount),base=largest.value.map((item,index)=>{const data=accounts.value[index]?.data,owner=data&&"parsed" in data&&typeof data.parsed.info?.owner==="string"?data.parsed.info.owner:"unknown",excluded=item.address.toBase58()===poolVault;return{rank:index+1,tokenAccount:item.address.toBase58(),owner,amountRaw:item.amount,percentage:total===0n?0:Number(BigInt(item.amount)*1_000_000n/total)/10_000,excluded,exclusionReason:excluded?"canonical_pool_vault":null}});
 const external=base.filter(x=>!x.excluded&&x.owner!=="unknown").slice(0,10);
 const [creatorResult,...holderResults]=key?await Promise.allSettled([firstFunding(creatorAddresses[0],key),...external.map(x=>firstFunding(x.owner,key))]):[];
 const fundingComplete=Boolean(key)&&creatorResult?.status==="fulfilled"&&holderResults.every(x=>x.status==="fulfilled");
 const creatorFunder=creatorResult?.status==="fulfilled"?creatorResult.value?.from??null:null;
 const fundingMap=new Map(external.map((x,i)=>{const result=holderResults[i];return[x.owner,result?.status==="fulfilled"?result.value:null]})),holders:HolderNode[]=base.map(x=>({...x,funding:fundingMap.get(x.owner)??null}));
 return{slot:BigInt(largest.context.slot),supplyRaw:supply.value.amount,holders,creatorClusterPct:computeCreatorCluster(holders,creatorAddresses,creatorFunder,fundingComplete),creatorFunder,fundingComplete};
}
