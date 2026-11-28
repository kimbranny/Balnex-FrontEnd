import { loadSrc, makeRunner, storage } from "./load.mjs";
const mem = storage;
const L = await loadSrc("lib/lifecycleLock.js");
const { STATE, OP, TX } = L;
const t = makeRunner();
const ok = (n, c, e) => t.ok(n, c, e);
const reset = () => { mem.clear(); L.__resetGuardForTests(); };
const A={wallet:"W1",name:"TokA",symbol:"AAA",decimals:9,supply:"1000"};
const MINTA="MintA111", POOL="Pool111";
async function createTokenA(){ const r=L.acquireForCreation(A); r.handle.setMint(MINTA); r.handle.signing(); r.handle.submitted({signature:"sigC",blockhash:"bh"}); r.handle.confirmed({mint:MINTA,signature:"sigC"}); return r; }
async function toPoolRunning(){ await createTokenA(); const p=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); p.handle.signing(); p.handle.submitted({signature:"sigP",blockhash:"bh"}); p.handle.confirmed({poolId:POOL,lpMint:"LP",signature:"sigP"}); }

// 1
reset(); { const a=L.acquireForCreation(A); ok("1 create A acquires",a.ok); a.handle.end(); const b=L.acquireForCreation({...A,name:"TokB",wallet:"W2"}); ok("1 token B blocked",!b.ok&&b.code==="TOKEN_LOCKED",JSON.stringify(b)); ok("1 lock state TOKEN_RESERVED",L.getLock().status===STATE.TOKEN_RESERVED); }
// 2
reset(); await createTokenA(); { const b=L.acquireForCreation({...A,name:"TokB"}); ok("2 awaiting liquidity blocks other creation",!b.ok&&L.getLock().status===STATE.TOKEN_CREATED); const pb=L.beginCreatePool("OtherMint",{}); ok("2 pool for other token blocked",!pb.ok&&pb.code==="TOKEN_MISMATCH"); }
// 3
reset(); await createTokenA(); { const p1=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); ok("3 first pool op ok",p1.ok); const p2=L.beginCreatePool(MINTA,{}); ok("3 second pool creation blocked while pending",!p2.ok,JSON.stringify(p2)); ok("3 status POOL_PENDING",L.getLock().status===STATE.POOL_PENDING); p1.handle.end(); }
// 4
reset(); await toPoolRunning(); { ok("4 status POOL_RUNNING",L.getLock().status===STATE.POOL_RUNNING); const b=L.acquireForCreation({...A,name:"TokB"}); ok("4 token B blocked",!b.ok); const p=L.beginCreatePool(MINTA,{}); ok("4 pool creation again not allowed",!p.ok&&p.code==="NOT_ALLOWED_IN_STATE"); }
// 5 refresh: lock re-read purely from storage; simulate new page (guard reset, new session id via stored op)
reset(); await toPoolRunning(); { const snap=JSON.stringify(L.getLock()); L.__resetGuardForTests(); const again=L.getLock(); ok("5 lock persists after refresh",JSON.stringify(again)===snap&&again.mint===MINTA); }
// 6 wallet disconnect: lock is wallet-independent
reset(); await createTokenA(); { const b=L.acquireForCreation({...A,wallet:"OTHER",name:"B"}); ok("6 lock persists w/o/other wallet",!b.ok&&L.getLock().mint===MINTA); }
// 7 pool creation failure
reset(); await createTokenA(); { const p=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); p.handle.signing(); p.handle.failed({submitted:false,message:"rpc blew up",stage:"prepare"}); ok("7 lock persists",L.getLock()?.mint===MINTA); const retry=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); ok("7 safe retry for Token A allowed",retry.ok,JSON.stringify(retry)); retry.handle.end();
  const other=L.beginCreatePool("Other",{}); ok("7 retry for other token blocked",!other.ok); }
// 8 phantom signing failure
reset(); await createTokenA(); { const p=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); p.handle.signing(); p.handle.failed({submitted:false,message:"User rejected",stage:"signing"}); const l=L.getLock(); ok("8 lock persists after signing failure",!!l&&l.recovery.reason==="signing_failed"); ok("8 retry allowed",L.beginCreatePool(MINTA,{}).ok); }
// 9 submitted unknown
reset(); await createTokenA(); { const p=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); p.handle.signing(); p.handle.submitted({signature:"sigP",blockhash:"bh"}); p.handle.failed({submitted:true,message:"timeout",signature:"sigP",stage:"confirmation"}); const l=L.getLock(); ok("9 lock persists",!!l&&l.status===STATE.RECOVERY_REQUIRED&&l.op.signature==="sigP"); const r=L.beginCreatePool(MINTA,{}); ok("9 blind retry blocked",!r.ok,JSON.stringify(r));
  const v=L.applyVerification({rpcAvailable:false}); ok("9 RPC unavailable keeps lock",L.getLock().status===STATE.RECOVERY_REQUIRED&&L.getLock().recovery.reason==="rpc_unavailable");
  const v2=L.applyVerification({rpcAvailable:true,sigOutcome:"pending",poolStatus:"not_found"}); ok("9 pending sig keeps recovery",L.getLock().status===STATE.RECOVERY_REQUIRED);
  ok("9 retry still blocked",!L.beginCreatePool(MINTA,{}).ok);
  L.applyVerification({rpcAvailable:true,sigOutcome:"expired_unlanded",poolStatus:"not_found"}); ok("9 proven not landed -> safe retry",L.getLock().status===STATE.TOKEN_CREATED&&L.beginCreatePool(MINTA,{}).ok); }
reset(); await createTokenA(); { const p=L.beginCreatePool(MINTA,{expectedPoolId:POOL}); p.handle.submitted({signature:"sigP",blockhash:"bh"}); p.handle.failed({submitted:true,signature:"sigP"}); L.applyVerification({rpcAvailable:true,sigOutcome:"confirmed",poolStatus:"verified",poolId:POOL,lpMint:"LP"}); ok("9b unknown tx later confirmed -> POOL_RUNNING",L.getLock().status===STATE.POOL_RUNNING&&L.getLock().poolId===POOL); }
// 10 removal pending
reset(); await toPoolRunning(); { const r=L.beginRemoveLiquidity(MINTA,{}); ok("10 removal begins",r.ok); r.handle.signing(); r.handle.submitted({signature:"sigR",blockhash:"bh"}); r.handle.confirmed({signature:"sigR"}); ok("10 removal pending lock persists",L.getLock()?.status===STATE.REMOVAL_PENDING); ok("10 add/remove/create blocked while pending",!L.beginRemoveLiquidity(MINTA,{}).ok&&!L.acquireForCreation(A).ok); }
// 11 removal failure
reset(); await toPoolRunning(); { const r=L.beginRemoveLiquidity(MINTA,{}); r.handle.signing(); r.handle.failed({submitted:false,message:"rejected",stage:"signing"}); ok("11 lock persists after removal failure",L.getLock()?.status===STATE.REMOVAL_PENDING); ok("11 retry blocked until re-check",!L.beginRemoveLiquidity(MINTA,{}).ok);
  L.applyVerification({rpcAvailable:true,sigOutcome:"none",poolStatus:"verified",lpRaw:1000n,poolId:POOL}); ok("11 re-check restores POOL_RUNNING and allows retry",L.getLock().status===STATE.POOL_RUNNING&&L.beginRemoveLiquidity(MINTA,{}).ok); }
// 12 removal verified -> released
reset(); await toPoolRunning(); { const r=L.beginRemoveLiquidity(MINTA,{}); r.handle.signing(); r.handle.submitted({signature:"sigR",blockhash:"bh"}); r.handle.confirmed({signature:"sigR"});
  L.applyVerification({rpcAvailable:true,sigOutcome:"confirmed",poolStatus:"verified",lpRaw:500n}); ok("12 partial removal does NOT release",L.getLock()?.status===STATE.POOL_RUNNING);
  const r2=L.beginRemoveLiquidity(MINTA,{}); r2.handle.submitted({signature:"sigR2",blockhash:"bh"}); r2.handle.confirmed({signature:"sigR2"});
  L.applyVerification({rpcAvailable:false}); ok("12 RPC down keeps lock",L.isLocked());
  L.applyVerification({rpcAvailable:true,sigOutcome:"confirmed",poolStatus:"verified",lpRaw:0n}); ok("12 verified removal releases lock",!L.isLocked()&&L.getLockRecord().status===STATE.RESOLVED&&L.getLockRecord().removeSignature==="sigR2"); }
// 12b: never released without proof
reset(); await toPoolRunning(); { const r=L.beginRemoveLiquidity(MINTA,{}); r.handle.submitted({signature:"s",blockhash:"b"}); r.handle.failed({submitted:true,signature:"s"}); L.applyVerification({rpcAvailable:true,sigOutcome:"unavailable",poolStatus:"verified",lpRaw:0n}); ok("12b unverified removal sig keeps lock",L.isLocked()); }
// 13 after release new creation allowed
reset(); await toPoolRunning(); { const r=L.beginRemoveLiquidity(MINTA,{}); r.handle.submitted({signature:"sR",blockhash:"b"}); r.handle.confirmed({signature:"sR"}); L.applyVerification({rpcAvailable:true,sigOutcome:"confirmed",poolStatus:"emptied",lpRaw:0n}); const b=L.acquireForCreation({...A,name:"TokB",wallet:"W2"}); ok("13 new creation allowed after verified release",b.ok&&L.getLock().name==="TokB"&&L.getLockHistory().length===1); }
// 14 double click create token
reset(); { const results=[L.acquireForCreation(A),L.acquireForCreation(A),L.acquireForCreation(A)]; ok("14 only one create op runs",results.filter(r=>r.ok).length===1,JSON.stringify(results.map(r=>r.ok||r.code))); }
// 15 double click create pool
reset(); await createTokenA(); { const rs=[L.beginCreatePool(MINTA,{}),L.beginCreatePool(MINTA,{})]; ok("15 only one pool op runs",rs.filter(r=>r.ok).length===1,JSON.stringify(rs.map(r=>r.ok||r.code))); }
// extra: creation failure paths
reset(); { const a=L.acquireForCreation(A); a.handle.setMint(MINTA); a.handle.signing(); a.handle.failed({submitted:false,stage:"signing",message:"rejected"}); ok("x token signing failure keeps lock + safe retry",L.isLocked()&&L.acquireForCreation(A).ok); }
reset(); { const a=L.acquireForCreation(A); a.handle.setMint(MINTA); a.handle.submitted({signature:"sC",blockhash:"b"}); a.handle.failed({submitted:true,signature:"sC"}); ok("x submitted creation unknown blocks retry",!L.acquireForCreation(A).ok);
  L.applyVerification({rpcAvailable:true,mintExists:true,sigOutcome:"confirmed"}); ok("x mint found -> TOKEN_CREATED w/ mint locked",L.getLock().status===STATE.TOKEN_CREATED&&L.getLock().mint===MINTA); }
reset(); { const a=L.acquireForCreation(A); a.handle.setMint(MINTA); a.handle.submitted({signature:"sC",blockhash:"b"}); a.handle.failed({submitted:true,signature:"sC"}); L.applyVerification({rpcAvailable:true,mintExists:false,sigOutcome:"pending"}); ok("x no mint + pending sig stays locked",L.getLock().status===STATE.RECOVERY_REQUIRED); L.applyVerification({rpcAvailable:true,mintExists:false,sigOutcome:"expired_unlanded"}); ok("x no mint + expired blockhash -> safe retry",L.getLock().status===STATE.TOKEN_RESERVED&&L.acquireForCreation(A).ok); }
// extra: orphaned op after refresh blocks
reset(); await createTokenA(); { const p=L.beginCreatePool(MINTA,{}); p.handle.signing(); const raw=JSON.parse(mem.get("balnex:lifecycle-lock:v1:devnet")); raw.lock.op.sessionId="old"; mem.set("balnex:lifecycle-lock:v1:devnet",JSON.stringify(raw)); L.__resetGuardForTests(); ok("x orphaned signing op blocks new ops",!L.beginCreatePool(MINTA,{}).ok); }
// extra: corrupt storage fails closed
reset(); mem.set("balnex:lifecycle-lock:v1:devnet","{not json"); ok("x corrupt storage fails closed",L.isLocked()&&!L.acquireForCreation(A).ok);
// extra: never auto-unlock by age
reset(); await createTokenA(); { const raw=JSON.parse(mem.get("balnex:lifecycle-lock:v1:devnet")); raw.lock.createdAt=1; raw.lock.updatedAt=1; mem.set("balnex:lifecycle-lock:v1:devnet",JSON.stringify(raw)); ok("x old lock does not expire",L.isLocked()); }
// extra: wrong mint
reset(); await toPoolRunning(); ok("x remove for other mint blocked",!L.beginRemoveLiquidity("Other",{}).ok);
// extra: add liquidity guard
reset(); await toPoolRunning(); { const a=L.beginAddLiquidity(MINTA,{}); ok("x add liquidity allowed only in POOL_RUNNING & sets pending",a.ok&&L.getLock().status===STATE.ADD_LIQUIDITY_PENDING&&!L.beginRemoveLiquidity(MINTA,{}).ok); a.handle.end(); }

// adoption of an existing token on pool creation
reset(); { const a=L.beginCreatePool("OldMint",{adopt:{wallet:"W1",name:"Old",symbol:"OLD",decimals:6},expectedPoolId:"P"}); ok("x adopt existing token when no lock",a.ok&&L.getLock().mint==="OldMint"&&L.getLock().status===STATE.POOL_PENDING); a.handle.end();
  const b=L.beginCreatePool("Another",{adopt:{wallet:"W1",name:"B",symbol:"B",decimals:6}}); ok("x adoption blocked when another lifecycle active",!b.ok&&L.getLock().mint==="OldMint"); }
// blockhash-only proof when signature never recorded
reset(); { const a=L.acquireForCreation(A); a.handle.setMint(MINTA); a.handle.submitted({blockhash:"bh"}); a.handle.failed({submitted:true,message:"closed"}); L.applyVerification({rpcAvailable:true,mintExists:false,sigOutcome:"pending"}); ok("x unsigned-record + blockhash still valid => stays locked",L.getLock().status===STATE.RECOVERY_REQUIRED); L.applyVerification({rpcAvailable:true,mintExists:false,sigOutcome:"expired_unlanded"}); ok("x blockhash expired + no mint => safe retry",L.getLock().status===STATE.TOKEN_RESERVED); }
process.exit(t.done("lifecycle lock") ? 1 : 0);
