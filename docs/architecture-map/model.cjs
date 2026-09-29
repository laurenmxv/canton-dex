/* Reviewed architecture structure: layers, modules, templates and choices. Module prose is extracted from local TSDoc. */
const ATLAS = (() => {
  const N = {
    session:'frontend.session', trader:'frontend.trader', operator:'frontend.operator', wallet:'frontend.wallet', data:'frontend.data',
    reads:'client.reads', onboardingApi:'client.onboarding', traderApi:'client.trader', operatorApi:'client.operator', http:'client.http',
    api:'backend.api', application:'backend.application', onboarding:'backend.onboarding', pools:'backend.pools', swaps:'backend.swaps', liquidity:'backend.liquidity', settlements:'backend.settlements', settlementQueues:'backend.settlement-queues', settlementDecision:'backend.settlement-decision', settlementAutomation:'backend.settlement-automation', tokens:'backend.tokens', adapters:'backend.adapters', stores:'backend.stores', dbClient:'backend.database-client', iam:'backend.iam', activity:'backend.activity', operations:'backend.operations', platform:'backend.platform',
    kyc:'contracts.kyc', access:'contracts.access', factory:'contracts.factory', proposal:'contracts.proposal', delegation:'contracts.delegation', pool:'contracts.pool', config:'contracts.config', state:'contracts.state', swapReceipt:'contracts.swap-receipt', liquidityReceipt:'contracts.liquidity-receipt',
    ledgerApi:'canton.ledger-api', hosting:'canton.party-hosting', execution:'canton.execution', ledger:'canton.ledger-state', synchronizer:'canton.synchronizer',
    externalWallet:'external.wallet', keycloak:'external.keycloak', database:'external.postgres', dvo:'external.dvo', tokenStandard:'external.token-standard'
  };
  const C = {requestSwap:'PoolAccess_RequestSwap', requestDeposit:'PoolAccess_RequestLiquidityDeposit', requestWithdrawal:'PoolAccess_RequestLiquidityWithdrawal', recover:'PoolAccess_RecoverAllocations', propose:'PoolFactory_ProposePool', create:'PoolFactory_CreatePool', accept:'PoolProposal_Accept', reject:'PoolProposal_Reject', withdrawProposal:'PoolProposal_Withdraw', settleSwap:'VenueDelegation_SettleBatch', settleDeposit:'VenueDelegation_AddLiquidity', settleWithdrawal:'VenueDelegation_WithdrawLiquidity', revoke:'VenueDelegation_Revoke', swap:'Pool_Swap', deposit:'Pool_AddLiquidity', withdrawal:'Pool_WithdrawLiquidity', fee:'PoolConfig_Update'};
  const nodes = {};
  function node(id,title,purpose,chips,source,extra={}) { nodes[id]={id,layer:id.split('.')[0],title,purpose,chips,source,...extra}; }
  const documentationSources = {
    [N.session]: {path:"frontend/src/app/runtime.tsx"},
    [N.trader]: {path:"frontend/src/features/swap/SwapDesk.tsx"},
    [N.operator]: {path:"frontend/src/features/settlement/PoolSettlement.tsx"},
    [N.wallet]: {path:"frontend/src/features/wallet/signing.ts"},
    [N.data]: {path:"frontend/src/app/useAsync.ts"},
    [N.reads]: {path:"client/src/client.ts"},
    [N.onboardingApi]: {path:"client/src/modules/onboarding/index.ts"},
    [N.traderApi]: {path:"client/src/modules/lp/index.ts"},
    [N.operatorApi]: {path:"client/src/modules/admin/index.ts"},
    [N.http]: {path:"client/src/core/http.ts"},
    [N.api]: {path:"backend/src/platform/server.ts",symbol:"createServer"},
    [N.application]: {path:"backend/src/main.ts"},
    [N.iam]: {path:"backend/src/iam/authentication.ts"},
    [N.activity]: {path:"backend/src/activity/routes.ts"},
    [N.operations]: {path:"backend/src/operations/commands.ts"},
    [N.platform]: {path:"backend/src/platform/server.ts"},
    [N.onboarding]: {path:"backend/src/onboarding/workflow.ts"},
    [N.pools]: {path:"backend/src/pools/workflow.ts"},
    [N.swaps]: {path:"backend/src/swaps/workflow.ts"},
    [N.liquidity]: {path:"backend/src/liquidity/workflow.ts"},
    [N.settlements]: {path:"backend/src/settlements/workflow.ts"},
    [N.settlementQueues]: {path:"backend/src/settlements/store.ts",symbol:"SettlementStore"},
    [N.settlementDecision]: {path:"backend/src/settlements/selection.ts"},
    [N.settlementAutomation]: {path:"backend/src/main.ts",symbol:"workers"},
    [N.tokens]: {path:"backend/src/tokens/workflow.ts"},
    [N.adapters]: {path:"backend/src/canton/ledger.ts"},
    [N.stores]: {path:"backend/src/swaps/store.ts",symbol:"SwapStore"},
    [N.dbClient]: {path:"backend/src/platform/database.ts"},
    [N.externalWallet]: {path:"frontend/src/wallet/types.ts"},
    [N.keycloak]: {path:"frontend/src/auth/keycloak.ts"},
    [N.dvo]: {path:"backend/src/cli/decide-pool.ts",symbol:"DVO"},
  };
  function documentedNode(id,title,chips,extra={}) { node(id,title,'',chips,`${documentationSources[id].path}:1`,extra); }
  documentedNode(N.session,"Session & navigation",["Sign-in", "Profile", "Role navigation"]);
  documentedNode(N.trader,"Trader workspace",["Onboarding", "Swap", "Liquidity", "Holdings"]);
  documentedNode(N.operator,"Operator workspace",["Access review", "Pools", "Settlement"]);
  documentedNode(N.wallet,"Wallet bridge",["Public key", "Topology signature", "Transaction signature"]);
  documentedNode(N.data,"API & live status",["API adapter", "Polling", "Notices"]);
  documentedNode(N.reads,"Account & catalogue",["Profile", "Pools", "Activity"]);
  documentedNode(N.onboardingApi,"Onboarding API",["Apply", "Prepare party", "Confirm party"]);
  documentedNode(N.traderApi,"Trader API",["Swaps", "Liquidity", "Tokens"]);
  documentedNode(N.operatorApi,"Operator API",["Review", "Proposals", "Settlement"]);
  documentedNode(N.http,"HTTP & errors",["Bearer token", "JSON", "Problem Details"]);
  documentedNode(N.api,"Fastify router",["HTTP entry point"]);
  documentedNode(N.application,"Application wiring",["main.ts"]);
  documentedNode(N.iam,"IAM",["iam/"]);
  documentedNode(N.activity,"Activity",["activity/"]);
  documentedNode(N.operations,"Operations",["operations/"]);
  documentedNode(N.platform,"Platform",["platform/"]);
  documentedNode(N.onboarding,"Onboarding",["Review", "Register party", "Grant access"],{"worker": true});
  documentedNode(N.pools,"Pools",["Proposals", "Withdrawals", "Discovery"],{"worker": true});
  documentedNode(N.swaps,"Swaps",["Quote", "Prepare", "Submit", "Recover"],{"worker": true});
  documentedNode(N.liquidity,"Liquidity",["Deposit", "Withdrawal", "Positions", "Recover"],{"worker": true});
  documentedNode(N.settlements,"Settlements",["Preview", "Dispatch", "Confirm / recover"],{"worker": true});
  documentedNode(N.settlementQueues,"Request queues",["Swap", "Deposit", "Withdrawal"]);
  documentedNode(N.settlementDecision,"Batch planner",["FIFO", "Family policies"]);
  documentedNode(N.settlementAutomation,"Background loops",["Automatic", "Recovery"],{"worker": true});
  documentedNode(N.tokens,"Tokens",["Balances", "Development grant", "Signed claim"]);
  documentedNode(N.adapters,"Canton client library",["canton/"]);
  documentedNode(N.stores,"Domain stores",["Logical grouping"]);
  documentedNode(N.dbClient,"Database client",["Kysely · pg"]);
  function contract(id,title,exact,purpose,signs,sees,source,extra={}) { node(id,title,purpose,[],source,{exact,signs,sees,choices:[],...extra}); }
  contract(N.kyc,'KYC approval','KycAttestation','Approved trader and allowed pools.','Operator','Trader','contracts/daml/KycAttestation.daml:7');
  contract(N.access,'Trader access','PoolAccess','Requests and expired-fund recovery.','Operator','Trader','contracts/daml/PoolAccess.daml:22',{note:'Current app onboarding grants access only to the pools approved in that review. Extending an existing trader to a later pool has no implemented app path. The DEX recovery wrapper requires current access/KYC; direct token withdrawal follows the issuer rules.'});
  contract(N.factory,'Pool factory','PoolFactory','Validates proposals and creates pool state.','DVO','Operator','contracts/daml/PoolFactory.daml:29',{note:'The current development fixture creates the factory. The application proposes pools against an existing factory; it has no factory-creation flow.'});
  contract(N.proposal,'Pool proposal','PoolProposal','Settings awaiting the DVO decision.','Operator · + DVO when accepted','DVO','contracts/daml/PoolFactory.daml:97',{note:'Conditional signatories: venueOperator always; settings.dvo only for an accepted proposal. Acceptance creates a successor then invokes the factory in the same transaction.'});
  contract(N.delegation,'Settlement permission','VenueDelegation','DVO grants settlement authority for one pool.','DVO','Operator','contracts/daml/VenueDelegation.daml:28',{note:'Settlement combines trader-authorized allocations, this DVO grant and the operator controller. Revoking this grant moves no funds and does not erase trader allocations.'});
  contract(N.pool,'Pool engine','Pool','Stable configuration and settlement choices.','DVO','Operator','contracts/daml/Pool.daml:38',{note:'Pool rules verify the allocations bound to trader terms and the actual output limits. Token effects, receipts and state replacement commit together on-ledger; the prior request and application database are separate transactions.'});
  contract(N.config,'Pricing configuration','PoolConfig','Fee and approved initial ratio.','DVO','Operator','contracts/daml/Pool.daml:117');
  contract(N.state,'Reserves & LP supply','PoolState','Reserves, backing holdings and LP supply.','DVO','Operator','contracts/daml/Pool.daml:138');
  contract(N.swapReceipt,'Swap result','SwapReceipt','Evidence of a settled swap.','DVO + Operator','Trader','contracts/daml/Pool.daml:21');
  contract(N.liquidityReceipt,'Liquidity result','LiquidityReceipt','Evidence of a deposit or redemption.','DVO + Operator','Trader','contracts/daml/Pool.daml:227');
  const choices={};
  function choice(owner,id,label,controller,source,consuming=false) { const c={owner,id,label,controller,source,consuming};choices[id]=c;nodes[owner].choices.push(id); }
  choice(N.access,C.requestSwap,'Request swap','Trader','contracts/daml/PoolAccess.daml:33');
  choice(N.access,C.requestDeposit,'Request deposit','Trader','contracts/daml/PoolAccess.daml:54');
  choice(N.access,C.requestWithdrawal,'Request redemption','Trader','contracts/daml/PoolAccess.daml:70');
  choice(N.access,C.recover,'Recover expired funds','Trader','contracts/daml/PoolAccess.daml:85');
  choice(N.factory,C.propose,'Propose pool','Operator','contracts/daml/PoolFactory.daml:39');
  choice(N.factory,C.create,'Create pool','DVO + Operator','contracts/daml/PoolFactory.daml:52');
  choice(N.proposal,C.accept,'Accept','DVO','contracts/daml/PoolFactory.daml:111',true);
  choice(N.proposal,C.reject,'Reject','DVO','contracts/daml/PoolFactory.daml:122',true);
  choice(N.proposal,C.withdrawProposal,'Withdraw proposal','Operator','contracts/daml/PoolFactory.daml:127',true);
  choice(N.delegation,C.settleSwap,'Settle swaps','Operator','contracts/daml/VenueDelegation.daml:39');
  choice(N.delegation,C.settleDeposit,'Settle deposits','Operator','contracts/daml/VenueDelegation.daml:51');
  choice(N.delegation,C.settleWithdrawal,'Settle redemptions','Operator','contracts/daml/VenueDelegation.daml:64');
  choice(N.delegation,C.revoke,'Revoke permission','DVO','contracts/daml/VenueDelegation.daml:77',true);
  choice(N.pool,C.swap,'Swap batch','DVO + Operator','contracts/daml/Pool.daml:63');
  choice(N.pool,C.deposit,'Deposit batch','DVO + Operator','contracts/daml/Pool.daml:85');
  choice(N.pool,C.withdrawal,'Redemption batch','DVO + Operator','contracts/daml/Pool.daml:101');
  choice(N.config,C.fee,'Change fee','DVO','contracts/daml/Pool.daml:130',true);
  node(N.ledgerApi,'Ledger API','Receives reads, commands and signed submissions.',['Read','Submit','Prepare / execute'],'backend/src/canton/http.ts:125');
  node(N.hosting,'Parties & hosting','Registers parties and verifies local confirmation hosting.',['Party identity','Public key','Hosting'],'backend/src/canton/external-parties.ts:168');
  node(N.execution,'Contract execution','Evaluates Daml rules and authorization.',['DEX packages','Authorization','Atomic effects'],'backend/src/canton/interactive.ts:197');
  node(N.ledger,'Ledger state & history','Exposes contracts and confirmed transaction effects.',['Active contracts','Transactions'],'backend/src/canton/ledger.ts:322',{note:'Separate from the DEX PostgreSQL database. This is a participant capability, not a new DEX storage service.'});
  node(N.synchronizer,'Global Synchronizer','Coordinates the connected participant.',['LocalNet: global'],'docker/localnet/participant-bootstrap.sc:6',{note:'LocalNet uses its own synchronizer under the alias global. It does not connect to the public Global Synchronizer.'});
  documentedNode(N.externalWallet,"MetaMask + Canton Snap",["External wallet"],{"external": true});
  documentedNode(N.keycloak,"Keycloak",["Identity provider"],{"external": true});
  node(N.database,'DEX PostgreSQL','Stores application progress and projections.',['Application database'],'docker/compose.dev.yaml:24',{external:true});
  documentedNode(N.dvo,"DVO",["Pool-authority party"]);
  node(N.tokenStandard,'Token Standard','Holdings, allocations and token settlement interfaces.',['Holdings','Allocation factory','Allocations','Settlement factory'],'contracts/daml/Lib/Tokens.daml:97',{external:true,note:'Ledger interfaces implemented by issuers. They are not local DEX templates or an HTTP token service.'});
  const layers={
    frontend:{name:'Frontend',number:'01',tag:'React application',purpose:'People request actions and understand their outcomes.',short:'Trader and operator workspaces · React + TypeScript',nodes:[N.session,N.trader,N.operator,N.wallet,N.data],context:[N.keycloak,N.externalWallet],boundary:'Browser application',note:'Wallet keys stay outside the application. The UI asks for a signature and sends it through the client.'},
    client:{name:'Client',number:'02',tag:'TypeScript library',purpose:'A small, typed vocabulary for calling the backend.',short:'Typed HTTP APIs for the backend · TypeScript',nodes:[N.reads,N.onboardingApi,N.traderApi,N.operatorApi,N.http],context:[],boundary:'Imported into the browser — no separate service',note:'The client sends requests. It does not sign, price, settle or own background polling.'},
    backend:{name:'Backend',number:'03',tag:'Node / TypeScript / Fastify',purpose:'Durable business workflows, explicit settlement and ledger integration.',short:'HTTP API, workflows and persistence · TypeScript + Fastify + PostgreSQL',nodes:[N.api,N.application,N.iam,N.activity,N.onboarding,N.pools,N.swaps,N.liquidity,N.settlements,N.settlementQueues,N.settlementDecision,N.settlementAutomation,N.tokens,N.adapters,N.stores,N.dbClient,N.operations,N.platform],context:[N.database],boundary:'Backend process, with a separate Canton network boundary',note:'Automatic settlement and recovery run as independent loops in the API process. Settlement boxes show logical responsibilities; request queues are backed by shared PostgreSQL tables. Canton client library is the internal canton/ integration package. Development setup tooling is omitted.'},
    contracts:{name:'Contracts',number:'04',tag:'Daml rules & state',purpose:'Who may act, what can change, and which effects commit together.',short:'Access, pools and settlement rules · Daml on Canton',nodes:[N.kyc,N.access,N.factory,N.proposal,N.delegation,N.pool,N.config,N.state,N.swapReceipt,N.liquidityReceipt],context:[N.tokenStandard],boundary:'DEX templates — executed by the Canton participant',note:'DVO = pool authority. Operator = venueOperator. Trader = trader. Signatory, observer and controller are different roles.'},
    canton:{name:'Canton',number:'05',tag:'Ledger runtime',purpose:'Hosts parties, evaluates contracts and confirms ledger effects.',short:'Participant · state · synchronizer',nodes:[N.ledgerApi,N.hosting,N.execution,N.ledger,N.synchronizer],context:[],boundary:'Application participant + its synchronizer connection',note:'Boxes show responsibilities. LocalNet configuration is the evidence baseline; no live deployment status is displayed.'}
  };
  // The All Layers view shows every layer at once; each view names its responsibility and stack in one line.
  const overview={name:'All Layers',short:'React UI → TypeScript client → Fastify backend → Daml contracts on Canton'};
  return {N,C,nodes,documentationSources,choices,layers,overview,baseline:'c36dd63',sourceRoot:'../../../../'};
})();
if(typeof module!=='undefined') module.exports=ATLAS;
