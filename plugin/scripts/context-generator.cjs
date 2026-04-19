"use strict";var Xs=Object.create;var se=Object.defineProperty;var Gs=Object.getOwnPropertyDescriptor;var Hs=Object.getOwnPropertyNames;var Bs=Object.getPrototypeOf,Ws=Object.prototype.hasOwnProperty;var Vs=(t,e)=>{for(var s in e)se(t,s,{get:e[s],enumerable:!0})},Ke=(t,e,s,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Hs(e))!Ws.call(t,r)&&r!==s&&se(t,r,{get:()=>e[r],enumerable:!(n=Gs(e,r))||n.enumerable});return t};var F=(t,e,s)=>(s=t!=null?Xs(Bs(t)):{},Ke(e||!t||!t.__esModule?se(s,"default",{value:t,enumerable:!0}):s,t)),Ys=t=>Ke(se({},"__esModule",{value:!0}),t);var wn={};Vs(wn,{generateContext:()=>qe});module.exports=Ys(wn);var Fs=F(require("path"),1),js=require("os"),$s=require("fs");var Xt=require("bun:sqlite");var N=require("path"),Me=require("os"),ne=require("fs");var Qe=require("url");var U=require("fs"),W=require("path"),ze=require("os"),Ie=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Ie||{}),Je=(0,W.join)((0,ze.homedir)(),".claude-mem"),Ce=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,W.join)(Je,"logs");(0,U.existsSync)(e)||(0,U.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,W.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,W.join)(Je,"settings.json");if((0,U.existsSync)(e)){let s=(0,U.readFileSync)(e,"utf-8"),r=(JSON.parse(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Ie[r]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let n=s;if(typeof s=="string")try{n=JSON.parse(s)}catch{n=s}if(e==="Bash"&&n.command)return`${e}(${n.command})`;if(n.file_path)return`${e}(${n.file_path})`;if(n.notebook_path)return`${e}(${n.notebook_path})`;if(e==="Glob"&&n.pattern)return`${e}(${n.pattern})`;if(e==="Grep"&&n.pattern)return`${e}(${n.pattern})`;if(n.url)return`${e}(${n.url})`;if(n.query)return`${e}(${n.query})`;if(e==="Task"){if(n.subagent_type)return`${e}(${n.subagent_type})`;if(n.description)return`${e}(${n.description})`}return e==="Skill"&&n.skill?`${e}(${n.skill})`:e==="LSP"&&n.operation?`${e}(${n.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),n=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),c=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${n}-${r} ${o}:${i}:${a}.${c}`}log(e,s,n,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Ie[e].padEnd(5),c=s.padEnd(6),d="";r?.correlationId?d=`[${r.correlationId}] `:r?.sessionId&&(d=`[session-${r.sessionId}] `);let l="";o!=null&&(o instanceof Error?l=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?l=`
`+JSON.stringify(o,null,2):l=" "+this.formatData(o));let E="";if(r){let{sessionId:f,memorySessionId:A,correlationId:S,...T}=r;Object.keys(T).length>0&&(E=` {${Object.entries(T).map(([b,y])=>`${b}=${y}`).join(", ")}}`)}let g=`[${i}] [${a}] [${c}] ${d}${n}${E}${l}`;if(this.logFilePath)try{(0,U.appendFileSync)(this.logFilePath,g+`
`,"utf8")}catch(f){process.stderr.write(`[LOGGER] Failed to write to log file: ${f}
`)}else process.stderr.write(g+`
`)}debug(e,s,n,r){this.log(0,e,s,n,r)}info(e,s,n,r){this.log(1,e,s,n,r)}warn(e,s,n,r){this.log(2,e,s,n,r)}error(e,s,n,r){this.log(3,e,s,n,r)}dataIn(e,s,n,r){this.info(e,`\u2192 ${s}`,n,r)}dataOut(e,s,n,r){this.info(e,`\u2190 ${s}`,n,r)}success(e,s,n,r){this.info(e,`\u2713 ${s}`,n,r)}failure(e,s,n,r){this.error(e,`\u2717 ${s}`,n,r)}timing(e,s,n,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${n}ms`})}happyPathError(e,s,n,r,o=""){let d=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=d?`${d[1].split("/").pop()}:${d[2]}`:"unknown",E={...n,location:l};return this.warn(e,`[HAPPY-PATH] ${s}`,E,r),o}},u=new Ce;var zs={};function qs(){return typeof __dirname<"u"?__dirname:(0,N.dirname)((0,Qe.fileURLToPath)(zs.url))}var Ks=qs();function Js(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let t=(0,N.join)((0,Me.homedir)(),".claude-mem"),e=(0,N.join)(t,"settings.json");try{if((0,ne.existsSync)(e)){let{readFileSync:s}=require("fs"),n=JSON.parse(s(e,"utf-8")),r=n.env??n;if(r.CLAUDE_MEM_DATA_DIR)return r.CLAUDE_MEM_DATA_DIR}}catch{}return t}var M=Js(),P=process.env.CLAUDE_CONFIG_DIR||(0,N.join)((0,Me.homedir)(),".claude"),jn=(0,N.join)(P,"plugins","marketplaces","thedotmack"),$n=(0,N.join)(M,"archives"),Pn=(0,N.join)(M,"logs"),Xn=(0,N.join)(M,"trash"),Gn=(0,N.join)(M,"backups"),Hn=(0,N.join)(M,"modes"),Bn=(0,N.join)(M,"settings.json"),Ze=(0,N.join)(M,"claude-mem.db"),Wn=(0,N.join)(M,"vector-db"),Vn=(0,N.join)(M,"observer-sessions"),Yn=(0,N.join)(P,"settings.json"),qn=(0,N.join)(P,"commands"),Kn=(0,N.join)(P,"CLAUDE.md");function et(t){(0,ne.mkdirSync)(t,{recursive:!0})}function tt(){return(0,N.join)(Ks,"..")}var st=require("crypto");var Qs=3e4;function re(t,e,s){return(0,st.createHash)("sha256").update([t||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function oe(t,e,s){let n=s-Qs;return t.prepare("SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?").get(e,n)}function ie(t,e,s,n,r){if(!e){u.warn("DB","insertCaptureSnapshot: missing observationId \u2014 skipping");return}try{t.prepare(`
      INSERT INTO observation_capture_snapshots (
        observation_id,
        memory_session_id,
        content_session_id,
        prompt_number,
        user_prompt,
        prior_assistant_message,
        tool_name,
        tool_input,
        tool_output,
        cwd,
        captured_type,
        captured_title,
        captured_subtitle,
        captured_narrative,
        captured_facts,
        captured_concepts,
        captured_why,
        captured_alternatives_rejected,
        captured_related_observation_ids,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s.memorySessionId,s.contentSessionId,s.promptNumber,s.userPrompt,s.priorAssistantMessage,s.toolName,s.toolInput,s.toolOutput,s.cwd,n.type,n.title,n.subtitle,n.narrative,n.facts,n.concepts,n.why,n.alternativesRejected,n.relatedObservationIds,r)}catch(o){u.warn("DB","insertCaptureSnapshot failed \u2014 observation persisted without snapshot",{observationId:e},o instanceof Error?o:void 0)}}function ae(t,e,s){return{memorySessionId:t,contentSessionId:e,promptNumber:s,userPrompt:null,priorAssistantMessage:null,toolName:null,toolInput:null,toolOutput:null,cwd:null}}function ce(t){return{type:t.type,title:t.title,subtitle:t.subtitle,narrative:t.narrative,facts:JSON.stringify(t.facts??[]),concepts:JSON.stringify(t.concepts??[]),why:t.why??null,alternativesRejected:t.alternatives_rejected??null,relatedObservationIds:t.related_observation_ids&&t.related_observation_ids.length>0?JSON.stringify(t.related_observation_ids):null}}function De(t){if(!t)return[];try{let e=JSON.parse(t);return Array.isArray(e)?e:[String(e)]}catch{return[t]}}function nt(t,e,s,n,r){if(e.length===0)return;u.debug(`[observation-feedback] recording ${s} for ${e.length} observations`);let o=t.prepare(`
    INSERT INTO observation_feedback (
      observation_id,
      signal_type,
      session_db_id,
      created_at_epoch,
      metadata
    ) VALUES (?, ?, ?, ?, ?)
  `),i=t.prepare(`
    UPDATE observations
    SET relevance_count = COALESCE(relevance_count, 0) + 1
    WHERE id = ?
  `),a=Date.now(),c=r?JSON.stringify(r):null;t.transaction(l=>{for(let E of l)o.run(E,s,n??null,a,c),s==="memory_assist_helpful"&&i.run(E)})(e)}function de(t,e=30){let s={windowDays:e,helpful:0,notHelpful:0,bySource:{}},n=Date.now()-e*24*60*60*1e3,r=t.prepare(`
    SELECT signal_type, metadata
    FROM observation_feedback
    WHERE created_at_epoch >= ?
      AND signal_type IN ('memory_assist_helpful', 'memory_assist_not_helpful')
  `).all(n);for(let o of r){let i="unknown";if(o.metadata)try{i=JSON.parse(o.metadata).source||i}catch{}s.bySource[i]||(s.bySource[i]={helpful:0,notHelpful:0}),o.signal_type==="memory_assist_helpful"?(s.helpful+=1,s.bySource[i].helpful+=1):(s.notHelpful+=1,s.bySource[i].notHelpful+=1)}return u.debug(`[observation-feedback] loaded feedback stats for ${e}d window (${r.length} rows)`),s}var I="claude";function Zs(t){return t.trim().toLowerCase().replace(/\s+/g,"-")}function X(t){if(!t)return I;let e=Zs(t);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:I}function rt(t){let e=["claude","codex","cursor"];return[...t].sort((s,n)=>{let r=e.indexOf(s),o=e.indexOf(n);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:s.localeCompare(n)})}var le=F(require("path"),1);function ue(t){if(!t)return[];try{let e=JSON.parse(t);return Array.isArray(e)?e:[]}catch(e){return u.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:t?.substring(0,50)},e),[]}}function Le(t){return new Date(t).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function me(t){return new Date(t).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function we(t){return new Date(t).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ot(t,e){return le.default.isAbsolute(t)?le.default.relative(e,t):t}function it(t,e,s){let n=ue(t);if(n.length>0)return ot(n[0],e);if(s){let r=ue(s);if(r.length>0)return ot(r[0],e)}return"General"}function en(t){return t?Math.ceil(t.length/4):0}function at(t,e){if(!t?.length)return 0;let s=new Set(t.map(i=>i.createdAtEpoch?we(i.createdAtEpoch):null).filter(i=>!!i)),n=[`This file has prior observations. ${e?`File: ${le.default.basename(e)}.`:""}`.trim(),"- Already know enough? The timeline below may be all you need.","- Need details? get_observations([IDs])."],r=t.map(i=>{let a=i.createdAtEpoch?me(i.createdAtEpoch):"",c=(i.title||"Untitled").replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim().slice(0,160);return`${i.observationId} ${a} ${i.type??"discovery"} ${c}`.trim()}),o=[...n,...Array.from(s).map(i=>`### ${i}`),...r].join(`
`);return en(o)}function _e(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}function G(t){return t==null?null:JSON.stringify(t)}function ct(t){t.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      project TEXT,
      platform_source TEXT,
      session_db_id INTEGER,
      content_session_id TEXT,
      prompt_number INTEGER,
      threshold REAL,
      best_distance REAL,
      worst_distance REAL,
      candidate_count INTEGER,
      selected_count INTEGER,
      prompt_length INTEGER,
      file_path TEXT,
      message TEXT,
      estimated_injected_tokens INTEGER,
      trace_items_json TEXT,
      shadow_ranking_json TEXT,
      system_verdict TEXT,
      system_confidence REAL,
      system_reasons_json TEXT,
      system_evidence_json TEXT,
      user_feedback TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_created ON memory_assist_decisions(created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_source ON memory_assist_decisions(source, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_content_session ON memory_assist_decisions(content_session_id, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_project ON memory_assist_decisions(project, created_at_epoch DESC)");let e=t.query("PRAGMA table_info(memory_assist_decisions)").all();e.some(s=>s.name==="prompt_number")||t.run("ALTER TABLE memory_assist_decisions ADD COLUMN prompt_number INTEGER"),e.some(s=>s.name==="system_evidence_json")||t.run("ALTER TABLE memory_assist_decisions ADD COLUMN system_evidence_json TEXT")}function pe(t){return{id:t.id,source:t.source,status:t.status,reason:t.reason,timestamp:t.created_at_epoch,createdAtEpoch:t.created_at_epoch,updatedAtEpoch:t.updated_at_epoch,project:t.project??void 0,platformSource:t.platform_source??void 0,sessionDbId:t.session_db_id??void 0,contentSessionId:t.content_session_id??void 0,promptNumber:t.prompt_number??void 0,threshold:t.threshold??void 0,bestDistance:t.best_distance,worstDistance:t.worst_distance,candidateCount:t.candidate_count??void 0,selectedCount:t.selected_count??void 0,promptLength:t.prompt_length??void 0,filePath:t.file_path??void 0,message:t.message??void 0,estimatedInjectedTokens:t.estimated_injected_tokens??void 0,traceItems:_e(t.trace_items_json,[]),shadowRanking:_e(t.shadow_ranking_json,null),systemVerdict:t.system_verdict,systemConfidence:t.system_confidence,systemReasons:_e(t.system_reasons_json,[]),systemEvidence:_e(t.system_evidence_json,null),userFeedback:t.user_feedback}}function dt(t,e){let s=e.timestamp??Date.now();u.debug(`[memory-assist-decisions] recording ${e.source}/${e.status} decision (${e.reason})`);let r=t.prepare(`
    INSERT INTO memory_assist_decisions (
      source,
      status,
      reason,
      project,
      platform_source,
      session_db_id,
      content_session_id,
      prompt_number,
      threshold,
      best_distance,
      worst_distance,
      candidate_count,
      selected_count,
      prompt_length,
      file_path,
      message,
      estimated_injected_tokens,
      trace_items_json,
      shadow_ranking_json,
      system_verdict,
      system_confidence,
      system_reasons_json,
      system_evidence_json,
      user_feedback,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.source,e.status,e.reason,e.project??null,e.platformSource??null,e.sessionDbId??null,e.contentSessionId??null,e.promptNumber??null,e.threshold??null,e.bestDistance??null,e.worstDistance??null,e.candidateCount??null,e.selectedCount??null,e.promptLength??null,e.filePath??null,e.message??null,e.estimatedInjectedTokens??null,G(e.traceItems??[]),G(e.shadowRanking??null),e.systemVerdict??null,e.systemConfidence??null,G(e.systemReasons??[]),G(e.systemEvidence??null),e.userFeedback??null,s,s),o=tn(t,Number(r.lastInsertRowid));return u.debug(`[memory-assist-decisions] stored decision ${o.id??"unknown"}`),o}function tn(t,e){let s=t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id = ?
  `).get(e);return s?pe(s):null}function V(t,e={}){let s=Math.min(Math.max(e.limit??20,1),1e4),n=[],r=[];e.windowDays&&(n.push("created_at_epoch >= ?"),r.push(Date.now()-e.windowDays*24*60*60*1e3)),e.source&&(n.push("source = ?"),r.push(e.source)),e.project&&(n.push("project = ?"),r.push(e.project)),e.contentSessionId&&(n.push("content_session_id = ?"),r.push(e.contentSessionId));let o=n.length>0?`WHERE ${n.join(" AND ")}`:"",a=t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    ${o}
    ORDER BY created_at_epoch DESC
    LIMIT ${s}
  `).all(...r).map(pe);return u.debug(`[memory-assist-decisions] loaded ${a.length} recent decisions (limit=${s})`),a}function lt(t,e,s,n){let r=Date.now()-n;return t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND prompt_number = ?
      AND created_at_epoch >= ?
    ORDER BY created_at_epoch DESC
  `).all(e,s,r).map(pe)}function ut(t,e,s,n,r,o){t.prepare(`
    UPDATE memory_assist_decisions
    SET system_verdict = ?,
        system_confidence = ?,
        system_reasons_json = ?,
        system_evidence_json = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(s,n,G(r),G(o),Date.now(),e)}function mt(t,e,s){t.prepare(`
    UPDATE memory_assist_decisions
    SET user_feedback = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(s,Date.now(),e)}function xe(t,e){if(e.length===0)return[];let s=e.map(()=>"?").join(", ");return t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id IN (${s})
  `).all(...e).map(pe)}function Y(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}function q(t){return t==null?null:JSON.stringify(t)}function _t(t){t.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_outcome_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER,
      pending_message_id INTEGER,
      source TEXT,
      prompt_number INTEGER,
      content_session_id TEXT,
      session_db_id INTEGER,
      project TEXT,
      platform_source TEXT,
      signal_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      related_file_paths_json TEXT,
      concepts_json TEXT,
      generated_observation_ids_json TEXT,
      metadata_json TEXT,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES memory_assist_decisions(id) ON DELETE SET NULL
    )
  `),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_decision ON memory_assist_outcome_signals(decision_id, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_session ON memory_assist_outcome_signals(content_session_id, created_at_epoch DESC)");let e=t.query("PRAGMA table_info(memory_assist_outcome_signals)").all();e.some(s=>s.name==="prompt_number")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN prompt_number INTEGER"),e.some(s=>s.name==="pending_message_id")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN pending_message_id INTEGER"),e.some(s=>s.name==="generated_observation_ids_json")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN generated_observation_ids_json TEXT")}function pt(t){return{id:t.id,decisionId:t.decision_id,pendingMessageId:t.pending_message_id,source:t.source,promptNumber:t.prompt_number??void 0,contentSessionId:t.content_session_id??void 0,sessionDbId:t.session_db_id??void 0,project:t.project??void 0,platformSource:t.platform_source??void 0,signalType:t.signal_type,toolName:t.tool_name,action:t.action,filePath:t.file_path,relatedFilePaths:Y(t.related_file_paths_json,[]),concepts:Y(t.concepts_json,[]),generatedObservationIds:Y(t.generated_observation_ids_json,[]),metadata:Y(t.metadata_json,{}),timestamp:t.created_at_epoch}}function Et(t,e){let s=e.timestamp??Date.now();u.debug(`[memory-assist-outcomes] recording ${e.action} outcome for ${e.source??"unknown source"}`);let n=t.prepare(`
    INSERT INTO memory_assist_outcome_signals (
      decision_id,
      pending_message_id,
      source,
      prompt_number,
      content_session_id,
      session_db_id,
      project,
      platform_source,
      signal_type,
      tool_name,
      action,
      file_path,
      related_file_paths_json,
      concepts_json,
      generated_observation_ids_json,
      metadata_json,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.decisionId??null,e.pendingMessageId??null,e.source??null,e.promptNumber??null,e.contentSessionId??null,e.sessionDbId??null,e.project??null,e.platformSource??null,e.signalType,e.toolName,e.action,e.filePath??null,q(e.relatedFilePaths??[]),q(e.concepts??[]),q(e.generatedObservationIds??[]),q(e.metadata??{}),s),r=t.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE id = ?
  `).get(Number(n.lastInsertRowid)),o=r?pt(r):{...e,id:Number(n.lastInsertRowid),timestamp:s};return u.debug(`[memory-assist-outcomes] stored outcome signal ${o.id??"unknown"}`),o}function gt(t,e,s){if(s.length===0)return[];let n=t.prepare(`
    SELECT generated_observation_ids_json
    FROM memory_assist_outcome_signals
    WHERE pending_message_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e);if(!n)return u.debug(`[memory-assist-outcomes] no outcome signal found for pending message ${e}`),[];let r=Y(n.generated_observation_ids_json,[]),o=[...new Set([...r,...s])];return t.prepare(`
    UPDATE memory_assist_outcome_signals
    SET generated_observation_ids_json = ?
    WHERE pending_message_id = ?
  `).run(q(o),e),u.debug(`[memory-assist-outcomes] attached ${s.length} observations to pending message ${e}`),o}function Tt(t,e){if(e.length===0)return{};let s=e.map(()=>"?").join(", "),n=t.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE decision_id IN (${s})
    ORDER BY created_at_epoch ASC
  `).all(...e),r=n.reduce((o,i)=>{let a=i.decision_id;return a==null||(o[a]||(o[a]=[]),o[a].push(pt(i))),o},{});return u.debug(`[memory-assist-outcomes] loaded ${n.length} outcome signals for ${e.length} decisions`),r}function Ue(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}var sn="__context__",nn="other";function Ee(t){return{id:t.id,observationId:t.observation_id,pendingMessageId:t.pending_message_id,decisionId:t.decision_id,contentSessionId:t.content_session_id??void 0,sessionDbId:t.session_db_id??void 0,promptNumber:t.prompt_number??void 0,toolName:t.tool_name,action:t.action,filePath:t.file_path,createdAtEpoch:t.created_at_epoch,contextType:t.context_type??null,contextRef:Ue(t.context_ref_json??null,null)}}function bt(t){t.run(`
    CREATE TABLE IF NOT EXISTS observation_tool_origins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      pending_message_id INTEGER,
      decision_id INTEGER,
      content_session_id TEXT,
      session_db_id INTEGER,
      prompt_number INTEGER,
      tool_name TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      created_at_epoch INTEGER NOT NULL,
      context_type TEXT,
      context_ref_json TEXT,
      FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
      FOREIGN KEY(decision_id) REFERENCES memory_assist_decisions(id) ON DELETE SET NULL
    )
  `),t.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, ''))"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_observation ON observation_tool_origins(observation_id)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_pending ON observation_tool_origins(pending_message_id)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)")}function ke(t,e,s){if(s.length===0)return[];let n=t.prepare(`
    SELECT
      id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      generated_observation_ids_json,
      created_at_epoch
    FROM memory_assist_outcome_signals
    WHERE pending_message_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e);if(!n)return u.debug("DB",`memory-assist-origins: no outcome signal found for pending message ${e}`),[];let r=Ue(n.generated_observation_ids_json,[]),o=r.length>0?s.filter(l=>r.includes(l)):s;if(o.length===0)return u.debug("DB",`memory-assist-origins: no exact observation ids to attach for pending message ${e}`),[];let i=t.prepare(`
    INSERT OR REPLACE INTO observation_tool_origins (
      observation_id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);t.transaction(l=>{for(let E of l)i.run(E,n.pending_message_id,n.decision_id,n.content_session_id,n.session_db_id,n.prompt_number,n.tool_name,n.action,n.file_path,n.created_at_epoch)})(o);let c=o.map(()=>"?").join(", "),d=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE pending_message_id = ?
      AND observation_id IN (${c})
    ORDER BY observation_id ASC
  `).all(e,...o);return u.debug("DB",`memory-assist-origins: attached ${d.length} observation origins for pending message ${e}`),d.map(Ee)}function ft(t,e){let s=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e);return s?Ee(s):null}function ht(t,e,s,n,r=Date.now()){if(!Number.isFinite(e)||e<=0)return u.warn("DB",`memory-assist-origins: insertContextOrigin: invalid observationId=${e} \u2014 skipping`),null;let o=n.contentSessionId??n.content_session_id??null,i=n.sessionDbId??n.session_db_id??null,a=n.promptNumber??n.prompt_number??null;t.prepare(`
    INSERT OR IGNORE INTO observation_tool_origins (
      observation_id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      created_at_epoch,
      context_type,
      context_ref_json
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(e,o,i,a,sn,nn,r,s,JSON.stringify(n));let d=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ? AND context_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e,s);return d?Ee(d):(u.debug("DB",`memory-assist-origins: insertContextOrigin: no row materialized for obs=${e} (already existed?)`),null)}function St(t,e){return t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id ASC
  `).all(e).map(Ee)}function Ot(t,e={}){let s=e.limit??200,n=e.windowDays??30,r=Date.now()-n*24*60*60*1e3,o=t.prepare(`
    SELECT
      id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      generated_observation_ids_json,
      created_at_epoch
    FROM memory_assist_outcome_signals
    WHERE created_at_epoch >= ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,s),i=0,a=0;for(let c of o){let d=Ue(c.generated_observation_ids_json,[]);if(d.length===0||c.pending_message_id==null){a+=1;continue}let l=ke(t,c.pending_message_id,d);if(l.length>0){i+=l.length;continue}a+=1}return u.debug("DB",`memory-assist-origins: backfill complete: resolved=${i} unresolved=${a}`),{resolvedCount:i,unresolvedCount:a}}function rn(t){return{id:t.id,project:t.project,source:t.source,semanticThreshold:t.semantic_threshold,injectLimit:t.inject_limit,minQueryLength:t.min_query_length,rankerId:t.ranker_id,createdAtEpoch:t.created_at_epoch,updatedAtEpoch:t.updated_at_epoch}}function At(t){t.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      source TEXT,
      semantic_threshold REAL,
      inject_limit INTEGER,
      min_query_length INTEGER,
      ranker_id TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `),t.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_assist_calibration_scope ON memory_assist_calibration(COALESCE(project, ''), COALESCE(source, ''))")}function Rt(t){let e=t.prepare(`
    SELECT *
    FROM memory_assist_calibration
    ORDER BY updated_at_epoch DESC
  `).all(),s={global:null,byProject:{},bySource:{},byProjectAndSource:{}};for(let n of e){let r=rn(n);if(!r.project&&!r.source){s.global??=r;continue}if(r.project&&r.source){s.byProjectAndSource[`${r.project}::${r.source}`]=r;continue}if(r.project){s.byProject[r.project]=r;continue}r.source&&(s.bySource[r.source]=r)}return u.debug(`[memory-assist-calibration] loaded ${e.length} calibration rows`),s}function yt(t,e,s,n){t.prepare(`PRAGMA table_info(${e})`).all().some(o=>o.name===s)||t.run(`ALTER TABLE ${e} ADD COLUMN ${s} ${n}`)}function Nt(t){t.run(`
    CREATE TABLE IF NOT EXISTS observation_type_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode_id TEXT,
      original_type TEXT NOT NULL,
      normalized_type TEXT NOT NULL,
      fallback_type TEXT NOT NULL,
      strategy TEXT NOT NULL,
      correlation_id TEXT,
      created_at_epoch INTEGER NOT NULL
    )
  `),yt(t,"observation_type_corrections","project","TEXT"),yt(t,"observation_type_corrections","platform_source","TEXT"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_created ON observation_type_corrections(created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_project ON observation_type_corrections(project)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_source ON observation_type_corrections(platform_source)")}function vt(t,e){u.debug(`[memory-assist-taxonomy] ${e.originalType} -> ${e.normalizedType} (${e.strategy}) in mode=${e.modeId}`),t.prepare(`
    INSERT INTO observation_type_corrections (
      mode_id,
      original_type,
      normalized_type,
      fallback_type,
      strategy,
      correlation_id,
      project,
      platform_source,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.modeId,e.originalType,e.normalizedType,e.fallbackType,e.strategy,e.correlationId??null,e.project??null,e.platformSource??null,Date.now())}function Fe(t,e=30,s={}){let n=Date.now()-e*24*60*60*1e3,r=["created_at_epoch >= ?"],o=[n];s.project&&(r.push("project = ?"),o.push(s.project)),s.platformSource&&(r.push("platform_source = ?"),o.push(s.platformSource));let i=t.prepare(`
    SELECT original_type, normalized_type, COUNT(*) AS count
    FROM observation_type_corrections
    WHERE ${r.join(" AND ")}
    GROUP BY original_type, normalized_type
    ORDER BY count DESC, original_type ASC
  `).all(...o),a={total:i.reduce((c,d)=>c+d.count,0),aliases:i.map(c=>({originalType:c.original_type,normalizedType:c.normalized_type,count:c.count}))};return u.debug(`[memory-assist-taxonomy] loaded correction stats for ${e}d window (${a.total} corrections)`),a}var It=F(require("path"),1);var w=require("fs"),K=require("path"),je=require("os"),k=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-6",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_CUSTOM_BASE_URL:"",CLAUDE_MEM_CUSTOM_API_KEY:"",CLAUDE_MEM_CUSTOM_MODEL:"",CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_CUSTOM_MAX_TOKENS:"100000",CLAUDE_MEM_CUSTOM_TEMPERATURE:"",CLAUDE_MEM_CUSTOM_MAX_OUTPUT_TOKENS:"",CLAUDE_MEM_DATA_DIR:(0,K.join)((0,je.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,K.join)((0,je.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_THRESHOLD:"0.35",CLAUDE_MEM_RECOMMENDER_PAUSED:"true",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){let s=this.get(e);return s==="true"||s===!0}static applyEnvOverrides(e){let s={...e};for(let n of Object.keys(this.DEFAULTS))process.env[n]!==void 0&&(s[n]=process.env[n]);return s}static loadFromFile(e){try{if(!(0,w.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,K.dirname)(e);(0,w.existsSync)(a)||(0,w.mkdirSync)(a,{recursive:!0}),(0,w.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a)}return this.applyEnvOverrides(i)}let s=(0,w.readFileSync)(e,"utf-8"),n=JSON.parse(s),r=n;if(n.env&&typeof n.env=="object"){r=n.env;try{(0,w.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i)}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))r[i]!==void 0&&(o[i]=r[i]);return this.applyEnvOverrides(o)}catch(s){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,s),this.applyEnvOverrides(this.getAllDefaults())}}};var Ct="awaiting content-reuse signal";function Mt(){if(process.env.CLAUDE_MEM_RECOMMENDER_PAUSED!==void 0)return process.env.CLAUDE_MEM_RECOMMENDER_PAUSED==="true";try{let t=It.default.join(k.get("CLAUDE_MEM_DATA_DIR"),"settings.json");return k.loadFromFile(t).CLAUDE_MEM_RECOMMENDER_PAUSED==="true"}catch{return k.getBool("CLAUDE_MEM_RECOMMENDER_PAUSED")}}function D(t,e){return e<=0?null:Math.round(t/e*100)}function $e(t){return Math.round(t*10)/10}function on(t){let e=new Map;for(let s of t)s.status==="skipped"&&e.set(s.reason,(e.get(s.reason)??0)+1);return Array.from(e.entries()).sort((s,n)=>n[1]-s[1]||s[0].localeCompare(n[0])).slice(0,5).map(([s,n])=>({reason:s,count:n}))}function an(t){let e={likely_helped:0,unclear:0,likely_not_helped:0};for(let s of t)s.systemVerdict&&(e[s.systemVerdict]+=1);return e}function cn(t,e){return t.length!==e.length?!1:t.every((s,n)=>s===e[n])}function dn(t,e){let s=new Set(t),n=new Set(e),r=new Set([...s,...n]);return r.size===0?100:[...s].filter(i=>n.has(i)).length/r.size*100}function wt(t){let e=t.filter(i=>i.source==="semantic_prompt"&&i.shadowRanking?.experimentalSelectedObservationIds&&i.shadowRanking.productionSelectedObservationIds);if(e.length===0)return null;let s=0,n=0,r=0,o=0;for(let i of e){let a=[...i.shadowRanking?.productionSelectedObservationIds??[]].sort((d,l)=>d-l),c=[...i.shadowRanking?.experimentalSelectedObservationIds??[]].sort((d,l)=>d-l);if(cn(a,c)&&(s+=1),n+=dn(a,c),i.systemVerdict==="likely_helped"){o+=1;let d=new Set((i.traceItems??[]).map(E=>E.observationId));c.some(E=>d.has(E))&&(r+=1)}}return{totalCompared:e.length,exactMatches:s,exactMatchRate:D(s,e.length),divergentSelections:e.length-s,avgSelectionOverlapRate:$e(n/e.length),likelyHelpedWithExperimentalOverlap:r,likelyHelpedWithExperimentalOverlapRate:D(r,o)}}function ln(t,e){if(Mt())return{kind:"paused",reason:Ct,slice:e};if(t.actionable<20)return{kind:"insufficient_data",reason:"Need at least 20 actionable decisions before making a threshold recommendation.",confidence:.35,suggestedDelta:null,actionable:t.actionable,slice:e};let s=t.topSkipReasons.find(o=>o.reason==="below_threshold")?.count??0,n=s>0&&s>=Math.ceil(t.actionable*.25),r=(t.shadowRanking?.divergentSelections??0)>0||(t.shadowRanking?.likelyHelpedWithExperimentalOverlap??0)>0;return(t.injectRate??0)>=40&&(t.likelyHelpedRate??0)<=10?{kind:"lower_threshold",reason:"Injection volume is high, but few recalls are being judged helpful. Tighten the threshold slightly.",confidence:.8,suggestedDelta:-.05,actionable:t.actionable,slice:e}:(t.injectRate??0)<=5&&n&&r?{kind:"raise_threshold",reason:"Below-threshold skips dominate this slice and shadow ranking shows missed alternatives. Loosen the threshold slightly.",confidence:.72,suggestedDelta:.05,actionable:t.actionable,slice:e}:{kind:"keep_threshold",reason:"This slice looks balanced enough to keep the current threshold for now.",confidence:.58,suggestedDelta:0,actionable:t.actionable,slice:e}}function ge(t,e,s,n=null){let r=t.length,o=t.filter(p=>p.status==="injected").length,i=t.filter(p=>p.status==="skipped").length,a=t.filter(p=>p.status==="disabled").length,c=t.filter(p=>p.status==="error").length,d=o+i,l=an(t),E=l.likely_helped,g=t.filter(p=>p.userFeedback==="helpful").length,f=t.filter(p=>p.userFeedback==="not_helpful").length,A=t.reduce((p,R)=>p+(R.estimatedInjectedTokens??0),0),S=E,T=D(E,o),h=n??r,b=e==null?null:D(e,h),y={total:r,actionable:d,injected:o,injectRate:D(o,d),likelyHelped:E,likelyHelpedRate:D(E,d),userConfirmedHelpful:g,userConfirmedHelpfulRate:D(g,g+f),helped:S,checkedNoHelp:Math.max(o-S,0),disabled:a,errors:c,helpRate:T,topSkipReasons:on(t),verdicts:l,estimatedInjectedTokens:A,helpfulRecallsPer1kInjectedTokens:A>0?$e(E/A*1e3):null,injectedTokensPerLikelyHelpedRecall:E>0?$e(A/E):null,taxonomyCorrectionCount:e,taxonomyCorrectionRate:b,shadowRanking:wt(t)};return{...y,recommendation:ln(y,s)}}function Dt(t,e,s){let n=Date.now()-e*24*60*60*1e3,r=s?"SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? AND project = ?":"SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ?";return(s?t.prepare(r).get(n,s):t.prepare(r).get(n)).c}function Lt(t,e,s,n=null){return{source:t,...ge(e,s,{scope:"source",key:t,source:t},n)}}function un(t,e,s,n=null){return{project:t,...ge(e,s,{scope:"project",key:t,project:t},n)}}function mn(t,e,s,n){return{project:t,source:e,...ge(s,n,{scope:"project_source",key:`${t}::${e}`,project:t,source:e})}}function xt(t,e,s=30){let n=e.filter(p=>p.source==="semantic_prompt"),r=e.filter(p=>p.source==="file_context"),o=e.filter(p=>p.status==="injected").length,i=e.filter(p=>p.status==="skipped").length,a=o+i,c=e.filter(p=>p.systemVerdict==="likely_helped").length,d=de(t,s),l=Fe(t,s),E=e.filter(p=>p.userFeedback==="helpful").length,g=e.filter(p=>p.userFeedback==="not_helpful").length,f=Dt(t,s),A=ge(e,l.total,{scope:"global",key:"global"},f),S=[...new Set(e.map(p=>p.project).filter(p=>typeof p=="string"&&p.length>0))].sort((p,R)=>p.localeCompare(R)),T=Object.fromEntries(S.map(p=>{let R=e.filter(m=>m.project===p),v=Fe(t,s,{project:p}),B=Dt(t,s,p);return[p,un(p,R,v.total,B)]})),h=S.flatMap(p=>["semantic_prompt","file_context"].map(R=>{let v=e.filter(m=>m.project===p&&m.source===R);return[`${p}::${R}`,mn(p,R,v,null)]})),b={semantic_prompt:Lt("semantic_prompt",n,null),file_context:Lt("file_context",r,null)},y={windowDays:s,totalDecisions:e.length,injected:o,injectRate:D(o,a),likelyHelped:c,likelyHelpedRate:D(c,a),userConfirmedHelpfulRate:D(E,E+g),estimatedInjectedTokens:A.estimatedInjectedTokens,helpfulRecallsPer1kInjectedTokens:A.helpfulRecallsPer1kInjectedTokens,injectedTokensPerLikelyHelpedRecall:A.injectedTokensPerLikelyHelpedRecall,taxonomyCorrectionRate:A.taxonomyCorrectionRate,helped:c,checkedNoHelp:Math.max(o-c,0),helpRate:D(c,o),feedback:d,helpful:d.helpful,notHelpful:d.notHelpful,bySource:d.bySource,sourceStats:b,projectStats:T,projectSourceStats:Object.fromEntries(h),availableProjects:S,taxonomyCorrections:l,shadowRanking:wt(n),recommendation:A.recommendation};return u.debug(`[memory-assist-dashboard] built dashboard for ${s}d window using ${e.length} decisions across ${S.length} projects`),y}function L(t,e){return u.debug(`[MemoryAssistJudge] decision=${t.id??"new"} source=${t.source} status=${t.status} verdict=${e.verdict} confidence=${e.confidence.toFixed(2)}`),e}function Te(){return{matchedTracePaths:[],usedOutcomes:[],ignoredOutcomes:[]}}function x(t){return t?t.replace(/\\/g,"/").trim().toLowerCase():null}function _n(t){let e=new Set;for(let s of t.traceItems??[]){let n=x(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=x(r);o&&e.add(o)}}return e}function pn(t){let e=new Set;for(let s of t){let n=x(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=x(r);o&&e.add(o)}}return e}function H(t,e){let s=new Set,n=x(t.filePath);n&&e.has(n)&&s.add(n);for(let r of t.relatedFilePaths??[]){let o=x(r);o&&e.has(o)&&s.add(o)}return[...s]}function En(t,e,s){let n=new Set(e.generatedObservationIds??[]),r=new Set(s),o=new Set;for(let i of t.traceItems??[]){if(n.has(i.observationId)){o.add(i.observationId);continue}let a=x(i.filePath);if(a&&r.has(a)){o.add(i.observationId);continue}(i.relatedFilePaths??[]).some(d=>{let l=x(d);return l!=null&&r.has(l)})&&o.add(i.observationId)}return[...o]}function gn(t,e){let s=new Set((e.concepts??[]).map(r=>r.trim().toLowerCase()).filter(Boolean));if(s.size===0)return 0;let n=new Set;for(let r of t.traceItems??[])for(let o of r.concepts??[]){let i=o.trim().toLowerCase();i&&s.has(i)&&n.add(i)}return n.size}function J(t,e){return(t.generatedObservationIds??[]).some(s=>e.has(s))}function Ft(t){return new Set(t)}function jt(t,e){return e.size===0?!1:H(t,e).some(s=>e.has(s))}function $(t,e,s,n){let r=Ft(s);return r.size===0?!1:e.some(o=>o===t||!n.includes(o.action)||(o.timestamp??0)>(t.timestamp??0)?!1:jt(o,r))}function $t(t,e,s,n){let r=Ft(s);return r.size===0?!1:e.some(o=>o===t||!n.includes(o.action)||(o.timestamp??0)<(t.timestamp??0)?!1:jt(o,r))}function Tn(t,e,s){return t.action==="browser"?"browser_follow_up":t.action==="command"?$(t,e,s,["edit","write"])?"terminal_follow_up":"other_follow_up":t.action==="read"?$t(t,e,s,["edit","write"])?"follow_up_read":"other_follow_up":(t.action==="edit"||t.action==="write")&&$(t,e,s,["read"])?"follow_up_edit":"other_follow_up"}function Ut(t,e,s,n,r,o){let i=En(t,e,n),a=gn(t,e),c=Tn(e,s,n),d=(e.generatedObservationIds?.length??0)>0?"exact_observation_link":c==="follow_up_edit"||c==="terminal_follow_up"?"sequence_only":e.action==="browser"?"browser_only":n.length>0?"file_overlap":"no_overlap",l=d==="exact_observation_link"?o?"primary":"supporting":d==="sequence_only"?o?"supporting":"context":d==="file_overlap"&&o?"supporting":"context";return{outcomeId:e.id,pendingMessageId:e.pendingMessageId??null,action:e.action,toolName:e.toolName,filePath:e.filePath??null,timestamp:e.timestamp,matchedPaths:n,matchedTraceObservationIds:i,generatedObservationIds:e.generatedObservationIds??[],conceptOverlapCount:a,sequenceRole:c,signalSource:d,evidenceStrength:l,reason:r}}function kt(t,e){return e.includes(t.action)}function j(t,e,s,n,r,o){let i=[],a=[];for(let c of e){let d=H(c,s);if(n(c,d)){i.push(Ut(t,c,e,d,r(c,d),!0));continue}a.push(Ut(t,c,e,d,o(c,d),!1))}return{matchedTracePaths:[...s],usedOutcomes:i,ignoredOutcomes:a}}function Pt(t,e,s=t.userFeedback){if(s==="helpful")return L(t,{verdict:"likely_helped",confidence:.98,reasons:["User marked this memory assist as helpful."],evidence:Te()});if(s==="not_helpful")return L(t,{verdict:"likely_not_helped",confidence:.98,reasons:["User marked this memory assist as not helpful."],evidence:Te()});if(t.status!=="injected")return L(t,{verdict:"unclear",confidence:.4,reasons:["No memory was injected, so there is no direct adoption signal to judge."],evidence:Te()});if(e.length===0)return L(t,{verdict:"unclear",confidence:.35,reasons:["No follow-up tool actions were recorded after this injection."],evidence:Te()});let n=t.promptNumber??null,r=new Set((t.traceItems??[]).map(m=>x(m.filePath)).filter(m=>!!m)),o=e.filter(m=>{if(m.action!=="read"||n==null||m.promptNumber==null||m.promptNumber!==n)return!0;let O=x(m.filePath);return O?!r.has(O):!0}),i=_n(t),a=pn(e),c=[...i].filter(m=>a.has(m)),d=c.length,l=new Set(c),E=e.filter(m=>H(m,l).length>0),g=E.filter(m=>m.action==="edit"||m.action==="write").length,f=o.filter(m=>m.action==="read"&&H(m,l).length>0).length,A=e.filter(m=>m.action==="browser").length,S=E.filter(m=>(m.generatedObservationIds?.length??0)>0).length,T=new Set((t.traceItems??[]).map(m=>m.observationId)),h=e.filter(m=>J(m,T)),b=h.length,y=h.filter(m=>m.action==="edit"||m.action==="write").length,p=h.filter(m=>m.action==="read").length,R=E.filter(m=>(m.action==="edit"||m.action==="write")&&$(m,E,H(m,l),["read"])).length,v=E.filter(m=>m.action==="command"&&$(m,E,H(m,l),["edit","write"])).length;return y>0?L(t,{verdict:"likely_helped",confidence:R>0?.96:.9,reasons:[`${y} follow-up edit/write action${y===1?"":"s"} generated observations that were reused directly in the trace.`,...R>0?[`${R} of those edit/write action${R===1?"":"s"} followed a prior read on the same file.`]:[],...v>0?[`${v} same-target command follow-up${v===1?"":"s"} landed after an edit/write action.`]:[],"This is stronger evidence than plain file overlap because the exact generated observation linked back into the final trace."],evidence:j(t,e,l,(m,O)=>J(m,T)&&kt(m,["edit","write"]),(m,O)=>{let ve=$(m,e,O,["read"]);return`Primary evidence: this ${m.action==="write"?"write":"edit"} generated observation content that was reused directly in the trace${ve?", and it followed a same-target read":""}.`},(m,O)=>J(m,T)?"Ignored by verdict because only edit/write actions count as adoption in this branch.":O.length>0?"Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.":"Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.")}):p>0?L(t,{verdict:"likely_helped",confidence:.78,reasons:[`${p} follow-up read action${p===1?"":"s"} generated observations that were reused directly in the trace.`,"This is stronger evidence than plain file overlap, but weaker than seeing the same target edited afterward."],evidence:j(t,e,l,m=>J(m,T)&&m.action==="read",()=>"Primary evidence: this read generated observation content that was reused directly in the trace.",(m,O)=>J(m,T)?"Ignored by verdict because only read-based exact trace reuse counted in this branch.":O.length>0?"Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.":"Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.")}):d>0&&g>0?L(t,{verdict:"likely_helped",confidence:b>0?.94:v>0?.91:S>0||R>0?.9:.88,reasons:[`Injected memory overlapped with ${d} file path${d===1?"":"s"} touched afterward.`,`${g} follow-up edit/write action${g===1?"":"s"} used those same files.`,...R>0?[`${R} of those edit/write action${R===1?"":"s"} followed a prior read on the same file.`]:[],...S>0?[`${S} matching follow-up action${S===1?"":"s"} produced exact linked observation${S===1?"":"s"}.`]:[],...b>0?[`${b} follow-up action${b===1?"":"s"} generated observations that were reused directly in the trace.`]:[],...v>0?[`${v} same-target command follow-up${v===1?"":"s"} landed after an edit/write action.`]:[]],evidence:j(t,e,l,(m,O)=>O.length>0&&kt(m,["edit","write"]),(m,O)=>{let ve=$(m,e,O,["read"]),Ps=$t(m,e,O,["command"]);return`${(m.generatedObservationIds?.length??0)>0?"Primary":"Supporting"} evidence: it ${m.action==="write"?"wrote":"edited"} ${O.length===1?"the matched file":"matched files"}${(m.generatedObservationIds?.length??0)>0?` and generated ${m.generatedObservationIds.length} exact linked observation${m.generatedObservationIds.length===1?"":"s"}`:""}${ve?", after a same-target read":""}${Ps?", with a same-target command follow-up afterward":""}.`},(m,O)=>O.length>0?`Ignored by verdict because only edit/write overlap counted here${(m.generatedObservationIds?.length??0)>0?", even though this tool action generated exact linked observations":""}.`:`Ignored by verdict because it did not overlap with the injected memory paths${(m.generatedObservationIds?.length??0)>0?", even though it generated exact linked observations":""}.`)}):v>0?L(t,{verdict:"likely_helped",confidence:.83,reasons:[`${v} same-target command follow-up${v===1?"":"s"} landed after an edit/write action on the matched files.`,"That is weaker than direct trace reuse, but stronger than plain overlap because the command followed work on the same target."],evidence:j(t,e,l,(m,O)=>m.action==="command"&&O.length>0&&$(m,e,O,["edit","write"]),(m,O)=>`Supporting evidence: this command followed an edit/write on ${O.length===1?"the matched file":"matched files"} and stayed on the same target set.`,(m,O)=>O.length>0?"Ignored by verdict because only same-target command follow-ups counted in this branch.":"Ignored by verdict because it did not stay on the injected memory target set.")}):d>0&&f>0&&(f>=2||S>0||b>0)?L(t,{verdict:"likely_helped",confidence:b>0?.84:S>0?.78:.74,reasons:[`Injected memory overlapped with ${d} file path${d===1?"":"s"} revisited afterward.`,`${f} follow-up read action${f===1?"":"s"} revisited the same files.`,...S>0?[`${S} matching follow-up action${S===1?"":"s"} produced exact linked observation${S===1?"":"s"}.`]:[],...b>0?[`${b} follow-up action${b===1?"":"s"} generated observations that were reused directly in the trace.`]:[]],evidence:j(t,e,l,(m,O)=>O.length>0&&m.action==="read",(m,O)=>`${(m.generatedObservationIds?.length??0)>0?"Primary":"Supporting"} evidence: it reread ${O.length===1?"the matched file":"matched files"}${(m.generatedObservationIds?.length??0)>0?` and generated ${m.generatedObservationIds.length} exact linked observation${m.generatedObservationIds.length===1?"":"s"}`:""}.`,(m,O)=>O.length>0?`Ignored by verdict because only read overlap counted in this branch${(m.generatedObservationIds?.length??0)>0?", even though this tool action generated exact linked observations":""}.`:`Ignored by verdict because it did not overlap with the injected memory paths${(m.generatedObservationIds?.length??0)>0?", even though it generated exact linked observations":""}.`)}):A>0?L(t,{verdict:"unclear",confidence:.46,reasons:["The follow-up signal was mostly browser/UI activity, which is weaker evidence than file overlap."],evidence:j(t,e,l,m=>m.action==="browser",()=>"Context-only evidence: browser/UI follow-up was the only available signal.",(m,O)=>O.length>0?"Ignored by verdict because browser/UI activity took precedence in this branch.":"Ignored by verdict because it did not overlap with the injected memory paths.")}):L(t,{verdict:"likely_not_helped",confidence:.62,reasons:["The injection was not followed by related file overlap or a concrete follow-up action."],evidence:j(t,e,l,()=>!1,()=>"Unused.",(m,O)=>O.length>0?"Ignored by verdict because there was overlap, but no qualifying follow-up action.":"Ignored by verdict because it did not overlap with the injected memory paths.")})}function be(t){return t?t.replace(/\\/g,"/").trim().toLowerCase():null}function bn(t){let e=new Set,s=be(t.filePath);s&&e.add(s);for(let n of t.relatedFilePaths??[]){let r=be(n);r&&e.add(r)}return e}function fn(t){let e=new Set;for(let s of t.traceItems??[]){let n=be(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=be(r);o&&e.add(o)}}return e}function hn(t,e){return{customTitle:t,platformSource:e?X(e):void 0}}var fe=class{db;constructor(e=Ze){e!==":memory:"&&et(M),this.db=new Xt.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureObservationFeedbackTable(),this.ensureMemoryAssistTables(),this.createObservationsFTSIndex(),this.addObservationDecisionDNAFields(),this.addCaptureSnapshotTables(),this.addObservationContextOriginFields(),this.addMcpInvocationsTable()}createObservationsFTSIndex(){let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0;try{e||(this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
            title, subtitle, narrative, text, facts, concepts,
            content='observations', content_rowid='id',
            tokenize='porter unicode61'
          )
        `),this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `),this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END
        `),this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `),this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')"),u.debug("DB","SessionStore: Created observations_fts virtual table, sync triggers, and backfilled existing rows"))}catch(s){u.warn("DB","FTS5 not available, observations_fts index skipped",{},s)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()),u.debug("DB","SessionStore: Observations FTS5 index ensured")}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),u.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),u.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1&&n.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}u.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),u.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}u.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),u.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let n=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!n||n.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}u.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),u.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}u.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);try{this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `),this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `)}catch(n){u.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},n)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),u.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}u.debug("DB","Creating pending_messages table"),this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),u.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;u.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,n=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),c=a.some(l=>l.name===o);return a.some(l=>l.name===i)?!1:c?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),u.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(u.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};n("sdk_sessions","claude_session_id","content_session_id")&&s++,n("sdk_sessions","sdk_session_id","memory_session_id")&&s++,n("pending_messages","claude_session_id","content_session_id")&&s++,n("observations","sdk_session_id","memory_session_id")&&s++,n("session_summaries","sdk_session_id","memory_session_id")&&s++,n("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?u.debug("DB",`Successfully renamed ${s} session ID columns`):u.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),u.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){u.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;
        `),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),u.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(s){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),s}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),u.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),u.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${I}'`),u.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${I}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(r=>r.name==="generated_by_model"),n=e.some(r=>r.name==="relevance_count");s&&n||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureObservationFeedbackTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        session_db_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensureMemoryAssistTables(){ct(this.db),_t(this.db),bt(this.db),At(this.db),Nt(this.db)}addObservationDecisionDNAFields(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29),s=this.db.query("PRAGMA table_info(observations)").all(),n=new Set(s.map(a=>a.name)),r=!n.has("why"),o=!n.has("alternatives_rejected"),i=!n.has("related_observation_ids");if(!(e&&!r&&!o&&!i)){r&&this.db.run("ALTER TABLE observations ADD COLUMN why TEXT"),o&&this.db.run("ALTER TABLE observations ADD COLUMN alternatives_rejected TEXT"),i&&this.db.run("ALTER TABLE observations ADD COLUMN related_observation_ids TEXT");try{this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&(this.db.query("PRAGMA table_info(observations_fts)").all().some(l=>l.name==="why")||(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_fts"),this.db.run(`
            CREATE VIRTUAL TABLE observations_fts USING fts5(
              title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected,
              content='observations', content_rowid='id',
              tokenize='porter unicode61'
            )
          `),this.db.run(`
            CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts, new.why, new.alternatives_rejected);
            END
          `),this.db.run(`
            CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts, old.why, old.alternatives_rejected);
            END
          `),this.db.run(`
            CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts, old.why, old.alternatives_rejected);
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts, new.why, new.alternatives_rejected);
            END
          `),this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')"),u.debug("DB","SessionStore: rebuilt observations_fts with why + alternatives_rejected columns")))}catch(a){u.warn("DB","SessionStore: FTS5 extension for V29 skipped",{},a instanceof Error?a:void 0)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString()),u.debug("DB","SessionStore: migration V29 complete (why/alternatives_rejected/related_observation_ids)")}}addCaptureSnapshotTables(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(30),s=this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observation_capture_snapshots','observation_rubric_scores')").all(),n=new Set(s.map(i=>i.name)),r=!n.has("observation_capture_snapshots"),o=!n.has("observation_rubric_scores");e&&!r&&!o||(r&&(this.db.run(`
        CREATE TABLE IF NOT EXISTS observation_capture_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL,
          memory_session_id TEXT,
          content_session_id TEXT,
          prompt_number INTEGER,
          user_prompt TEXT,
          prior_assistant_message TEXT,
          tool_name TEXT,
          tool_input TEXT,
          tool_output TEXT,
          cwd TEXT,
          captured_type TEXT,
          captured_title TEXT,
          captured_subtitle TEXT,
          captured_narrative TEXT,
          captured_facts TEXT,
          captured_concepts TEXT,
          captured_why TEXT,
          captured_alternatives_rejected TEXT,
          captured_related_observation_ids TEXT,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
        )
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_capture_snapshot_obs ON observation_capture_snapshots(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_capture_snapshot_created ON observation_capture_snapshots(created_at_epoch DESC)")),o&&(this.db.run(`
        CREATE TABLE IF NOT EXISTS observation_rubric_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL,
          snapshot_id INTEGER,
          judge_model TEXT,
          fidelity REAL,
          intent_fit REAL,
          concept_accuracy REAL,
          type_correctness REAL,
          ceiling_flagged INTEGER,
          judge_notes TEXT,
          scored_at_epoch INTEGER NOT NULL,
          FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
        )
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_rubric_obs ON observation_rubric_scores(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_rubric_scored ON observation_rubric_scores(scored_at_epoch DESC)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString()),u.debug("DB","SessionStore: migration V30 complete (observation_capture_snapshots + observation_rubric_scores)"))}addObservationContextOriginFields(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(observation_tool_origins)").all();if(s.length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString());return}let n=new Set(s.map(i=>i.name)),r=!n.has("context_type"),o=!n.has("context_ref_json");e&&!r&&!o||(r&&this.db.run("ALTER TABLE observation_tool_origins ADD COLUMN context_type TEXT"),o&&this.db.run("ALTER TABLE observation_tool_origins ADD COLUMN context_ref_json TEXT"),this.db.run("DROP INDEX IF EXISTS idx_observation_tool_origins_observation_pending"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, ''))"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),u.debug("DB","SessionStore: migration V31 complete (context_type + context_ref_json on observation_tool_origins)"))}addMcpInvocationsTable(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_invocations'").get();e&&s||(this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_summary TEXT,
        result_status TEXT NOT NULL,
        error_message TEXT,
        duration_ms INTEGER,
        invoked_at_epoch INTEGER NOT NULL
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_mcp_invocations_tool_time ON mcp_invocations(tool_name, invoked_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_mcp_invocations_time ON mcp_invocations(invoked_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString()),u.debug("DB","SessionStore: migration V32 complete (mcp_invocations table)"))}updateMemorySessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e)}markSessionCompleted(e){let s=Date.now(),n=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(n,s,e)}ensureMemorySessionIdRegistered(e,s){let n=this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==s&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),u.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:s}))}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentSummariesWithSessionInfo(e,s=3){return this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentObservations(e,s=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getAllRecentObservations(e=100){return this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${I}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentSummaries(e=50){return this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${I}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentUserPrompts(e=100){return this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${I}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let s=e?X(e):void 0,n=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `,r=[];return s&&(n+=" AND COALESCE(platform_source, ?) = ?",r.push(I,s)),n+=" ORDER BY project ASC",this.db.prepare(n).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${I}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, '${I}'), project
      ORDER BY latest_epoch DESC
    `).all(),s=[],n=new Set,r={};for(let i of e){let a=X(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),n.has(i.project)||(n.add(i.project),s.push(i.project))}let o=rt(Object.keys(r));return{projects:s,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${I}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getLatestUserPromptEpoch(e){return this.db.prepare(`
      SELECT MAX(created_at_epoch) as latest_epoch
      FROM user_prompts
      WHERE content_session_id = ?
    `).get(e)?.latest_epoch??null}getLatestPendingWorkEpoch(e){return this.db.prepare(`
      SELECT MAX(epoch) as latest_epoch
      FROM (
        SELECT created_at_epoch as epoch
        FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
        UNION ALL
        SELECT started_processing_at_epoch as epoch
        FROM pending_messages
        WHERE session_db_id = ? AND status = 'processing' AND started_processing_at_epoch IS NOT NULL
      )
    `).get(e,e)?.latest_epoch??null}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(e,s)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationOrigin(e){return ft(this.db,e)}recordObservationFeedback(e,s,n,r){nt(this.db,e,s,n,r)}getObservationFeedbackStats(e=30){return de(this.db,e)}recordMemoryAssistDecision(e){let s=e.contentSessionId?this.getPromptNumberFromUserPrompts(e.contentSessionId):void 0,n=e.promptNumber??(s&&s>0?s:void 0),r=dt(this.db,{...e,promptNumber:n});return this.refreshMemoryAssistDecisionVerdict(r.id)??r}getRecentMemoryAssistDecisions(e={}){return V(this.db,e)}recordMemoryAssistOutcomeSignal(e){let s=e.promptNumber??(typeof e.metadata?.promptNumber=="number"?e.metadata.promptNumber:void 0),n=e.decisionId??this.resolveMemoryAssistDecisionId({...e,promptNumber:s}),r=Et(this.db,{...e,promptNumber:s,decisionId:n});return n&&this.refreshMemoryAssistDecisionVerdict(n),r}attachGeneratedObservationsToOutcomeSignal(e,s){if(s.length===0)return null;let n=gt(this.db,e,s);if(n.length===0)return null;let r=this.db.prepare(`
      SELECT *
      FROM memory_assist_outcome_signals
      WHERE pending_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(e);if(!r)return null;let o={id:r.id,decisionId:r.decision_id,pendingMessageId:e,source:r.source,promptNumber:r.prompt_number??void 0,contentSessionId:r.content_session_id??void 0,sessionDbId:r.session_db_id??void 0,project:r.project??void 0,platformSource:r.platform_source??void 0,signalType:r.signal_type,toolName:r.tool_name,action:r.action,filePath:r.file_path,relatedFilePaths:r.related_file_paths_json?JSON.parse(r.related_file_paths_json):[],concepts:r.concepts_json?JSON.parse(r.concepts_json):[],generatedObservationIds:n,metadata:r.metadata_json?JSON.parse(r.metadata_json):{},timestamp:r.created_at_epoch};return o.decisionId&&this.refreshMemoryAssistDecisionVerdict(o.decisionId),o}attachObservationOriginsToPendingMessage(e,s){return ke(this.db,e,s)}insertContextOrigin(e,s,n,r){return ht(this.db,e,s,n,r)}getObservationOrigins(e){return St(this.db,e)}resolveMemoryAssistDecisionId(e){if(!e.contentSessionId||!e.promptNumber)return null;let s=lt(this.db,e.contentSessionId,e.promptNumber,900*1e3);if(s.length===0)return null;let n=bn(e),r=s.filter(a=>a.status==="injected"),o=r.filter(a=>{if(a.source!=="file_context"||n.size===0)return!1;let c=fn(a);return[...n].some(d=>c.has(d))});if(o.length===1)return o[0].id;let i=r.filter(a=>a.source==="semantic_prompt");return i.length===1?i[0].id:r.length===1?r[0].id:null}attachMemoryAssistDecisionFeedback(e,s){mt(this.db,e,s),this.refreshMemoryAssistDecisionVerdict(e,s)}getMemoryAssistDashboard(e=30){let s=V(this.db,{limit:1e4,windowDays:e});return xt(this.db,s,e)}backfillRecentFileContextTokenEstimates(e={}){let s=V(this.db,{limit:e.limit??200,windowDays:e.windowDays??30,source:"file_context"}),n=0;for(let r of s){if(r.status!=="injected"||(r.estimatedInjectedTokens??0)>0)continue;let o=at(r.traceItems,r.filePath);o<=0||(this.db.prepare(`
        UPDATE memory_assist_decisions
        SET estimated_injected_tokens = ?,
            updated_at_epoch = ?
        WHERE id = ?
      `).run(o,Date.now(),r.id),n+=1)}return u.debug("DB",`memory-assist-decisions: backfilled file-context token estimates for ${n} decisions`),{updatedCount:n}}backfillRecentMemoryAssistEvidence(e={}){return V(this.db,{limit:e.limit??200,windowDays:e.windowDays??30}).map(r=>this.refreshMemoryAssistDecisionVerdict(r.id)??r)}backfillRecentObservationOrigins(e={}){return Ot(this.db,e)}getMemoryAssistCalibrationSnapshot(){return Rt(this.db)}recordObservationTypeCorrection(e){vt(this.db,e)}refreshMemoryAssistDecisionVerdict(e,s){let[n]=xe(this.db,[e]);if(!n)return null;let r=Tt(this.db,[e]),o=Pt(n,r[e]??[],s);return ut(this.db,e,o.verdict,o.confidence,o.reasons,o.evidence),xe(this.db,[e])[0]??null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o,type:i,concepts:a,files:c}=s,d=n==="date_asc"?"ASC":"DESC",l=r?`LIMIT ${r}`:"",E=e.map(()=>"?").join(","),g=[...e],f=[];if(o&&(f.push("project = ?"),g.push(o)),i)if(Array.isArray(i)){let T=i.map(()=>"?").join(",");f.push(`type IN (${T})`),g.push(...i)}else f.push("type = ?"),g.push(i);if(a){let T=Array.isArray(a)?a:[a],h=T.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");g.push(...T),f.push(`(${h.join(" OR ")})`)}if(c){let T=Array.isArray(c)?c:[c],h=T.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");T.forEach(b=>{g.push(`%${b}%`,`%${b}%`)}),f.push(`(${h.join(" OR ")})`)}let A=f.length>0?`WHERE id IN (${E}) AND ${f.join(" AND ")}`:`WHERE id IN (${E})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ORDER BY created_at_epoch ${d}
      ${l}
    `).all(...g)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let n=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),r=new Set,o=new Set;for(let i of n)De(i.files_read).forEach(a=>r.add(a)),De(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${I}') as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${I}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,n,r,o){let i=new Date,a=i.getTime(),c=hn(r,o),d=c.platformSource??I,l=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(l){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(s,e),c.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(c.customTitle,e),c.platformSource){let g=l.platform_source?.trim()?X(l.platform_source):void 0;if(!g)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(c.platformSource,e);else if(g!==c.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${g}, received=${c.platformSource}`)}return l.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,d,n,c.customTitle||null,i.toISOString(),a),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,s,n){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,n,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,n,r,o=0,i,a,c){let d=i??Date.now(),l=new Date(d).toISOString(),E=re(e,n.title,n.narrative),g=oe(this.db,E,d);if(g)return{id:g.id,createdAtEpoch:g.created_at_epoch};let A=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model, why, alternatives_rejected, related_observation_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,n.type,n.title,n.subtitle,JSON.stringify(n.facts),n.narrative,JSON.stringify(n.concepts),JSON.stringify(n.files_read),JSON.stringify(n.files_modified),r||null,o,E,l,d,a||null,n.why??null,n.alternatives_rejected??null,n.related_observation_ids&&n.related_observation_ids.length>0?JSON.stringify(n.related_observation_ids):null),S=Number(A.lastInsertRowid);return ie(this.db,S,c??ae(e,null,r??null),ce(n),d),{id:S,createdAtEpoch:d}}storeSummary(e,s,n,r,o=0,i){let a=i??Date.now(),c=new Date(a).toISOString(),l=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,r||null,o,c,a);return{id:Number(l.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,n,r,o,i=0,a,c,d){let l=a??Date.now(),E=new Date(l).toISOString();return this.db.transaction(()=>{let f=[],A=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),S=d??ae(e,null,o??null);for(let h of n){let b=re(e,h.title,h.narrative),y=oe(this.db,b,l);if(y){f.push(y.id);continue}let p=A.run(e,s,h.type,h.title,h.subtitle,JSON.stringify(h.facts),h.narrative,JSON.stringify(h.concepts),JSON.stringify(h.files_read),JSON.stringify(h.files_modified),o||null,i,b,E,l,c||null,h.why??null,h.alternatives_rejected??null,h.related_observation_ids&&h.related_observation_ids.length>0?JSON.stringify(h.related_observation_ids):null),R=Number(p.lastInsertRowid);f.push(R),ie(this.db,R,S,ce(h),l)}let T=null;if(r){let b=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,E,l);T=Number(b.lastInsertRowid)}return{observationIds:f,summaryId:T,createdAtEpoch:l}})()}storeObservationsAndMarkComplete(e,s,n,r,o,i,a,c=0,d,l,E){let g=d??Date.now(),f=new Date(g).toISOString();return this.db.transaction(()=>{let S=[],T=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),h=E??ae(e,null,a??null);for(let p of n){let R=re(e,p.title,p.narrative),v=oe(this.db,R,g);if(v){S.push(v.id);continue}let B=T.run(e,s,p.type,p.title,p.subtitle,JSON.stringify(p.facts),p.narrative,JSON.stringify(p.concepts),JSON.stringify(p.files_read),JSON.stringify(p.files_modified),a||null,c,R,f,g,l||null,p.why??null,p.alternatives_rejected??null,p.related_observation_ids&&p.related_observation_ids.length>0?JSON.stringify(p.related_observation_ids):null),m=Number(B.lastInsertRowid);S.push(m),ie(this.db,m,h,ce(p),g)}let b;if(r){let R=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,a||null,c,f,g);b=Number(R.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(g,o),{observationIds:S,summaryId:b,createdAtEpoch:g}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o}=s,i=n==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(","),d=[...e],l=o?`WHERE id IN (${c}) AND project = ?`:`WHERE id IN (${c})`;return o&&d.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...d)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o}=s,i=n==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(","),d=[...e],l=o?"AND s.project = ?":"";return o&&d.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${c}) ${l}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...d)}getTimelineAroundTimestamp(e,s=10,n=10,r){return this.getTimelineAroundObservation(null,e,s,n,r)}getTimelineAroundObservation(e,s,n=10,r=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],c,d;if(e!==null){let T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let b=this.db.prepare(T).all(e,...a,n+1),y=this.db.prepare(h).all(e,...a,r+1);if(b.length===0&&y.length===0)return{observations:[],sessions:[],prompts:[]};c=b.length>0?b[b.length-1].created_at_epoch:s,d=y.length>0?y[y.length-1].created_at_epoch:s}catch(b){return u.error("DB","Error getting boundary observations",void 0,{error:b,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let b=this.db.prepare(T).all(s,...a,n),y=this.db.prepare(h).all(s,...a,r+1);if(b.length===0&&y.length===0)return{observations:[],sessions:[],prompts:[]};c=b.length>0?b[b.length-1].created_at_epoch:s,d=y.length>0?y[y.length-1].created_at_epoch:s}catch(b){return u.error("DB","Error getting boundary timestamps",void 0,{error:b,project:o}),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,f=this.db.prepare(l).all(c,d,...a),A=this.db.prepare(E).all(c,d,...a),S=this.db.prepare(g).all(c,d,...a);return{observations:f,sessions:A.map(T=>({id:T.id,memory_session_id:T.memory_session_id,project:T.project,request:T.request,completed:T.completed,next_steps:T.next_steps,created_at:T.created_at,created_at_epoch:T.created_at_epoch})),prompts:S.map(T=>({id:T.id,content_session_id:T.content_session_id,prompt_number:T.prompt_number,prompt_text:T.prompt_text,project:T.project,created_at:T.created_at,created_at_epoch:T.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${s})
      ORDER BY p.created_at_epoch DESC
    `).all(...e)}getSessionSummaryById(e){return this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getOrCreateManualSession(e){let s=`manual-${e}`,n=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,n,e,I,o.toISOString(),o.getTime()),u.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}getObservationRetrievalContext(e){let s=new Map;if(e.length===0)return s;let n=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT observation_id, user_prompt, prior_assistant_message, content_session_id, prompt_number
      FROM observation_capture_snapshots
      WHERE observation_id IN (${n})
      GROUP BY observation_id
      HAVING created_at_epoch = MAX(created_at_epoch)
      ORDER BY observation_id
    `).all(...e);for(let o of r)s.set(o.observation_id,{user_prompt:o.user_prompt,prior_assistant_message:o.prior_assistant_message,content_session_id:o.content_session_id,prompt_number:o.prompt_number});return s}close(){this.db.close()}importSdkSession(e){let s=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,X(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ht=require("os"),Bt=F(require("path"),1);var Se=require("fs"),he=F(require("path"),1),z={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Gt(t){let e=he.default.join(t,".git"),s;try{s=(0,Se.statSync)(e)}catch{return z}if(!s.isFile())return z;let n;try{n=(0,Se.readFileSync)(e,"utf-8").trim()}catch{return z}let r=n.match(/^gitdir:\s*(.+)$/);if(!r)return z;let i=r[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return z;let a=i[1],c=he.default.basename(t),d=he.default.basename(a);return{isWorktree:!0,worktreeName:c,parentRepoPath:a,parentProjectName:d}}function Wt(t){return t==="~"||t.startsWith("~/")?t.replace(/^~/,(0,Ht.homedir)()):t}function Sn(t){if(!t||t.trim()==="")return u.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:t}),"unknown-project";let e=Wt(t),s=Bt.default.basename(e);if(s===""){if(process.platform==="win32"){let r=t.match(/^([A-Z]):\\/i);if(r){let i=`drive-${r[1].toUpperCase()}`;return u.info("PROJECT_NAME","Drive root detected",{cwd:t,projectName:i}),i}}return u.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:t}),"unknown-project"}return s}function Vt(t){let e=Sn(t);if(!t)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let s=Wt(t),n=Gt(s);if(n.isWorktree&&n.parentProjectName){let r=Array.from(new Set([n.parentProjectName,e]));return{primary:n.parentProjectName,parent:n.parentProjectName,isWorktree:!0,allProjects:r}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}var Yt=F(require("path"),1),qt=require("os");var Q=require("fs"),Oe=require("path");var C=class t{static instance=null;activeMode=null;modesDir;constructor(){let e=tt(),s=[(0,Oe.join)(e,"modes"),(0,Oe.join)(e,"..","plugin","modes")],n=s.find(r=>(0,Q.existsSync)(r));this.modesDir=n||s[0]}static getInstance(){return t.instance||(t.instance=new t),t.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let n={...e};for(let r in s){let o=s[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?n[r]=this.deepMerge(i,o):n[r]=o}return n}loadModeFile(e){let s=(0,Oe.join)(this.modesDir,`${e}.json`);if(!(0,Q.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let n=(0,Q.readFileSync)(s,"utf-8");return JSON.parse(n)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let c=this.loadModeFile(e);return this.activeMode=c,u.debug("SYSTEM",`Loaded mode: ${c.name} (${e})`,void 0,{types:c.observation_types.map(d=>d.id),concepts:c.observation_concepts.map(d=>d.id)}),c}catch{if(u.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:n,overrideId:r}=s,o;try{o=this.loadMode(n)}catch{u.warn("SYSTEM",`Parent mode '${n}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),u.debug("SYSTEM",`Loaded override file: ${r} for parent ${n}`)}catch{return u.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${n}' only`),this.activeMode=o,o}if(!i)return u.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${n}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,u.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${n} + ${r})`,void 0,{parent:n,override:r,types:a.observation_types.map(c=>c.id),concepts:a.observation_concepts.map(c=>c.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(n=>n.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(n=>n.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(n=>n.id===e)?.label||e}};function Pe(){let t=Yt.default.join((0,qt.homedir)(),".claude-mem","settings.json"),e=k.loadFromFile(t),s=C.getInstance().getActiveMode(),n=new Set(s.observation_types.map(o=>o.id)),r=new Set(s.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:n,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var _={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},Kt=4,Xe=1;function Ge(t){let e=(t.title?.length||0)+(t.subtitle?.length||0)+(t.narrative?.length||0)+JSON.stringify(t.facts||[]).length;return Math.ceil(e/Kt)}function He(t){let e=t.length,s=t.reduce((i,a)=>i+Ge(a),0),n=t.reduce((i,a)=>i+(a.discovery_tokens||0),0),r=n-s,o=n>0?Math.round(r/n*100):0;return{totalObservations:e,totalReadTokens:s,totalDiscoveryTokens:n,savings:r,savingsPercent:o}}function On(t){return C.getInstance().getWorkEmoji(t)}function Z(t,e){let s=Ge(t),n=t.discovery_tokens||0,r=On(t.type),o=n>0?`${r} ${n.toLocaleString()}`:"-";return{readTokens:s,discoveryTokens:n,discoveryDisplay:o,workEmoji:r}}function Ae(t){return t.showReadTokens||t.showWorkTokens||t.showSavingsAmount||t.showSavingsPercent}var zt=F(require("path"),1),Re=require("fs");var Jt=/<system-reminder>[\s\S]*?<\/system-reminder>/g;function Be(t,e,s,n){let r=Array.from(s.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(s.observationConcepts),a=i.map(()=>"?").join(",");return t.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE o.project = ?
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
      ${n?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,...r,...i,...n?[n]:[],s.totalObservationCount)}function We(t,e,s,n){return t.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE ss.project = ?
      ${n?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,...n?[n]:[],s.sessionCount+Xe)}function Qt(t,e,s,n){let r=Array.from(s.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(s.observationConcepts),a=i.map(()=>"?").join(","),c=e.map(()=>"?").join(",");return t.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE o.project IN (${c})
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
      ${n?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...r,...i,...n?[n]:[],s.totalObservationCount)}function Zt(t,e,s,n){let r=e.map(()=>"?").join(",");return t.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE ss.project IN (${r})
      ${n?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...n?[n]:[],s.sessionCount+Xe)}function An(t){return t.replace(/\//g,"-")}function Rn(t){try{if(!(0,Re.existsSync)(t))return{userMessage:"",assistantMessage:""};let e=(0,Re.readFileSync)(t,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),n="";for(let r=s.length-1;r>=0;r--)try{let o=s[r];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let c of i.message.content)c.type==="text"&&(a+=c.text);if(a=a.replace(Jt,"").trim(),a){n=a;break}}}catch(o){u.debug("PARSER","Skipping malformed transcript line",{lineIndex:r},o);continue}return{userMessage:"",assistantMessage:n}}catch(e){return u.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:t},e),{userMessage:"",assistantMessage:""}}}function Ve(t,e,s,n){if(!e.showLastMessage||t.length===0)return{userMessage:"",assistantMessage:""};let r=t.find(c=>c.memory_session_id!==s);if(!r)return{userMessage:"",assistantMessage:""};let o=r.memory_session_id,i=An(n),a=zt.default.join(P,"projects",i,`${o}.jsonl`);return Rn(a)}function es(t,e){let s=e[0]?.id;return t.map((n,r)=>{let o=r===0?null:e[r+1];return{...n,displayEpoch:o?o.created_at_epoch:n.created_at_epoch,displayTime:o?o.created_at:n.created_at,shouldShowLink:n.id!==s}})}function Ye(t,e){let s=[...t.map(n=>({type:"observation",data:n})),...e.map(n=>({type:"summary",data:n}))];return s.sort((n,r)=>{let o=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),s}function ts(t,e){return new Set(t.slice(0,e).map(s=>s.id))}function ss(){let t=new Date,e=t.toLocaleDateString("en-CA"),s=t.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),n=t.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${n}`}function ns(t){return[`# [${t}] recent context, ${ss()}`,""]}function rs(){return[`Legend: \u{1F3AF}session ${C.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji}${s.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function os(){return[]}function is(){return[]}function as(t,e){let s=[],n=[`${t.totalObservations} obs (${t.totalReadTokens.toLocaleString()}t read)`,`${t.totalDiscoveryTokens.toLocaleString()}t work`];return t.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?n.push(`${t.savingsPercent}% savings`):e.showSavingsAmount&&n.push(`${t.savings.toLocaleString()}t saved`)),s.push(`Stats: ${n.join(" | ")}`),s.push(""),s}function cs(t){return[`### ${t}`]}function ds(t){return t.toLowerCase().replace(" am","a").replace(" pm","p")}function ls(t,e,s){let n=t.title||"Untitled",r=C.getInstance().getTypeIcon(t.type),o=e?ds(e):'"';return`${t.id} ${o} ${r} ${n}`}function us(t,e,s,n){let r=[],o=t.title||"Untitled",i=C.getInstance().getTypeIcon(t.type),a=e?ds(e):'"',{readTokens:c,discoveryDisplay:d}=Z(t,n);r.push(`**${t.id}** ${a} ${i} **${o}**`),s&&r.push(s);let l=[];return n.showReadTokens&&l.push(`~${c}t`),n.showWorkTokens&&l.push(d),l.length>0&&r.push(l.join(" ")),r.push(""),r}function ms(t,e){return[`S${t.id} ${t.request||"Session started"} (${e})`]}function ee(t,e){return e?[`**${t}**: ${e}`,""]:[]}function _s(t){return t.assistantMessage?["","---","","**Previously**","",`A: ${t.assistantMessage}`,""]:[]}function ps(t,e){return["",`Access ${Math.round(t/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Es(t){return`# [${t}] recent context, ${ss()}

No previous sessions found.`}function gs(){let t=new Date,e=t.toLocaleDateString("en-CA"),s=t.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),n=t.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${n}`}function Ts(t){return["",`${_.bright}${_.cyan}[${t}] recent context, ${gs()}${_.reset}`,`${_.gray}${"\u2500".repeat(60)}${_.reset}`,""]}function bs(){let e=C.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji} ${s.id}`).join(" | ");return[`${_.dim}Legend: session-request | ${e}${_.reset}`,""]}function fs(){return[`${_.bright}Column Key${_.reset}`,`${_.dim}  Read: Tokens to read this observation (cost to learn it now)${_.reset}`,`${_.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${_.reset}`,""]}function hs(){return[`${_.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${_.reset}`,"",`${_.dim}When you need implementation details, rationale, or debugging context:${_.reset}`,`${_.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${_.reset}`,`${_.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${_.reset}`,`${_.dim}  - Trust this index over re-reading code for past decisions and learnings${_.reset}`,""]}function Ss(t,e){let s=[];if(s.push(`${_.bright}${_.cyan}Context Economics${_.reset}`),s.push(`${_.dim}  Loading: ${t.totalObservations} observations (${t.totalReadTokens.toLocaleString()} tokens to read)${_.reset}`),s.push(`${_.dim}  Work investment: ${t.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${_.reset}`),t.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let n="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?n+=`${t.savings.toLocaleString()} tokens (${t.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?n+=`${t.savings.toLocaleString()} tokens`:n+=`${t.savingsPercent}% reduction from reuse`,s.push(`${_.green}${n}${_.reset}`)}return s.push(""),s}function Os(t){return[`${_.bright}${_.cyan}${t}${_.reset}`,""]}function As(t){return[`${_.dim}${t}${_.reset}`]}function Rs(t,e,s,n){let r=t.title||"Untitled",o=C.getInstance().getTypeIcon(t.type),{readTokens:i,discoveryTokens:a,workEmoji:c}=Z(t,n),d=s?`${_.dim}${e}${_.reset}`:" ".repeat(e.length),l=n.showReadTokens&&i>0?`${_.dim}(~${i}t)${_.reset}`:"",E=n.showWorkTokens&&a>0?`${_.dim}(${c} ${a.toLocaleString()}t)${_.reset}`:"";return`  ${_.dim}#${t.id}${_.reset}  ${d}  ${o}  ${r} ${l} ${E}`}function ys(t,e,s,n,r){let o=[],i=t.title||"Untitled",a=C.getInstance().getTypeIcon(t.type),{readTokens:c,discoveryTokens:d,workEmoji:l}=Z(t,r),E=s?`${_.dim}${e}${_.reset}`:" ".repeat(e.length),g=r.showReadTokens&&c>0?`${_.dim}(~${c}t)${_.reset}`:"",f=r.showWorkTokens&&d>0?`${_.dim}(${l} ${d.toLocaleString()}t)${_.reset}`:"";return o.push(`  ${_.dim}#${t.id}${_.reset}  ${E}  ${a}  ${_.bright}${i}${_.reset}`),n&&o.push(`    ${_.dim}${n}${_.reset}`),(g||f)&&o.push(`    ${g} ${f}`),o.push(""),o}function Ns(t,e){let s=`${t.request||"Session started"} (${e})`;return[`${_.yellow}#S${t.id}${_.reset} ${s}`,""]}function te(t,e,s){return e?[`${s}${t}:${_.reset} ${e}`,""]:[]}function vs(t){return t.assistantMessage?["","---","",`${_.bright}${_.magenta}Previously${_.reset}`,"",`${_.dim}A: ${t.assistantMessage}${_.reset}`,""]:[]}function Is(t,e){let s=Math.round(t/1e3);return["",`${_.dim}Access ${s}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${_.reset}`]}function Cs(t){return`
${_.bright}${_.cyan}[${t}] recent context, ${gs()}${_.reset}
${_.gray}${"\u2500".repeat(60)}${_.reset}

${_.dim}No previous sessions found for this project yet.${_.reset}
`}function Ms(t,e,s,n){let r=[];return n?r.push(...Ts(t)):r.push(...ns(t)),n?r.push(...bs()):r.push(...rs()),n?r.push(...fs()):r.push(...os()),n?r.push(...hs()):r.push(...is()),Ae(s)&&(n?r.push(...Ss(e,s)):r.push(...as(e,s))),r}function yn(t){let e=new Map;for(let n of t){let r=n.type==="observation"?n.data.created_at:n.data.displayTime,o=we(r);e.has(o)||e.set(o,[]),e.get(o).push(n)}let s=Array.from(e.entries()).sort((n,r)=>{let o=new Date(n[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(s)}function Ds(t,e){return e.fullObservationField==="narrative"?t.narrative:t.facts?ue(t.facts).join(`
`):null}function Nn(t,e,s,n){let r=[];r.push(...cs(t));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,c=Le(a.displayTime);r.push(...ms(a,c))}else{let a=i.data,c=me(a.created_at),l=c!==o?c:"";if(o=c,s.has(a.id)){let g=Ds(a,n);r.push(...us(a,l,g,n))}else r.push(ls(a,l,n))}return r}function vn(t,e,s,n,r){let o=[];o.push(...Os(t));let i=null,a="";for(let c of e)if(c.type==="summary"){i=null,a="";let d=c.data,l=Le(d.displayTime);o.push(...Ns(d,l))}else{let d=c.data,l=it(d.files_modified,r,d.files_read),E=me(d.created_at),g=E!==a;a=E;let f=s.has(d.id);if(l!==i&&(o.push(...As(l)),i=l),f){let A=Ds(d,n);o.push(...ys(d,E,g,A,n))}else o.push(Rs(d,E,g,n))}return o.push(""),o}function In(t,e,s,n,r,o){return o?vn(t,e,s,n,r):Nn(t,e,s,n)}function Ls(t,e,s,n,r){let o=[],i=yn(t);for(let[a,c]of i)o.push(...In(a,c,e,s,n,r));return o}function ws(t,e,s){return!(!t.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||s&&e.created_at_epoch<=s.created_at_epoch)}function xs(t,e){let s=[];return e?(s.push(...te("Investigated",t.investigated,_.blue)),s.push(...te("Learned",t.learned,_.yellow)),s.push(...te("Completed",t.completed,_.green)),s.push(...te("Next Steps",t.next_steps,_.magenta))):(s.push(...ee("Investigated",t.investigated)),s.push(...ee("Learned",t.learned)),s.push(...ee("Completed",t.completed)),s.push(...ee("Next Steps",t.next_steps))),s}function Us(t,e){return e?vs(t):_s(t)}function ks(t,e,s){return!Ae(e)||t.totalDiscoveryTokens<=0||t.savings<=0?[]:s?Is(t.totalDiscoveryTokens,t.totalReadTokens):ps(t.totalDiscoveryTokens,t.totalReadTokens)}var Cn=Fs.default.join((0,js.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Mn(){try{return new fe}catch(t){if(t.code==="ERR_DLOPEN_FAILED"){try{(0,$s.unlinkSync)(Cn)}catch(e){u.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return u.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw t}}function Dn(t,e){return e?Cs(t):Es(t)}function Ln(t,e,s,n,r,o,i){let a=[],c=He(e);a.push(...Ms(t,c,n,i));let d=s.slice(0,n.sessionCount),l=es(d,s),E=Ye(e,l),g=ts(e,n.fullObservationCount);a.push(...Ls(E,g,n,r,i));let f=s[0],A=e[0];ws(n,f,A)&&a.push(...xs(f,i));let S=Ve(e,n,o,r);return a.push(...Us(S,i)),a.push(...ks(c,n,i)),a.join(`
`).trimEnd()}async function qe(t,e=!1){let s=Pe(),n=t?.cwd??process.cwd(),r=Vt(n),o=r.primary,i=t?.platform_source,a=t?.projects??r.allProjects;t?.full&&(s.totalObservationCount=999999,s.sessionCount=999999);let c=Mn();if(!c)return"";try{let d=a.length>1?Qt(c,a,s,i):Be(c,o,s,i),l=a.length>1?Zt(c,a,s,i):We(c,o,s,i);return d.length===0&&l.length===0?Dn(o,e):Ln(o,d,l,s,n,t?.session_id,e)}finally{c.close()}}0&&(module.exports={generateContext});
