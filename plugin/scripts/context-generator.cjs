"use strict";var Js=Object.create;var ue=Object.defineProperty;var zs=Object.getOwnPropertyDescriptor;var Qs=Object.getOwnPropertyNames;var Zs=Object.getPrototypeOf,en=Object.prototype.hasOwnProperty;var tn=(t,e)=>{for(var s in e)ue(t,s,{get:e[s],enumerable:!0})},at=(t,e,s,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Qs(e))!en.call(t,r)&&r!==s&&ue(t,r,{get:()=>e[r],enumerable:!(n=zs(e,r))||n.enumerable});return t};var W=(t,e,s)=>(s=t!=null?Js(Zs(t)):{},at(e||!t||!t.__esModule?ue(s,"default",{value:t,enumerable:!0}):s,t)),sn=t=>at(ue({},"__esModule",{value:!0}),t);var er={};tn(er,{generateContext:()=>ot});module.exports=sn(er);var Vs=W(require("path"),1),Ys=require("os"),qs=require("fs");var Ke=require("bun:sqlite");var R=require("path"),ke=require("os"),V=require("fs");var dt=require("url");var F=require("fs"),ct=require("path");var Ue=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Ue||{}),xe=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=Q.logsDir();(0,F.existsSync)(e)||(0,F.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,ct.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=Q.settings();if((0,F.existsSync)(e)){let s=(0,F.readFileSync)(e,"utf-8"),r=(JSON.parse(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Ue[r]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let n=s;if(typeof s=="string")try{n=JSON.parse(s)}catch{n=s}if(e==="Bash"&&n.command)return`${e}(${n.command})`;if(n.file_path)return`${e}(${n.file_path})`;if(n.notebook_path)return`${e}(${n.notebook_path})`;if(e==="Glob"&&n.pattern)return`${e}(${n.pattern})`;if(e==="Grep"&&n.pattern)return`${e}(${n.pattern})`;if(n.url)return`${e}(${n.url})`;if(n.query)return`${e}(${n.query})`;if(e==="Task"){if(n.subagent_type)return`${e}(${n.subagent_type})`;if(n.description)return`${e}(${n.description})`}return e==="Skill"&&n.skill?`${e}(${n.skill})`:e==="LSP"&&n.operation?`${e}(${n.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),n=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),c=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${n}-${r} ${o}:${i}:${a}.${c}`}log(e,s,n,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Ue[e].padEnd(5),c=s.padEnd(6),d="";r?.correlationId?d=`[${r.correlationId}] `:r?.sessionId&&(d=`[session-${r.sessionId}] `);let u="";if(o!=null)if(o instanceof Error)u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{u=`
`+JSON.stringify(o,null,2)}catch{u=" "+this.formatData(o)}else u=" "+this.formatData(o);let p="";if(r){let{sessionId:g,memorySessionId:h,correlationId:A,...f}=r;Object.keys(f).length>0&&(p=` {${Object.entries(f).map(([E,T])=>`${E}=${T}`).join(", ")}}`)}let b=`[${i}] [${a}] [${c}] ${d}${n}${p}${u}`;if(this.logFilePath)try{(0,F.appendFileSync)(this.logFilePath,b+`
`,"utf8")}catch(g){process.stderr.write(`[LOGGER] Failed to write to log file: ${g instanceof Error?g.message:String(g)}
`)}else process.stderr.write(b+`
`)}debug(e,s,n,r){this.log(0,e,s,n,r)}info(e,s,n,r){this.log(1,e,s,n,r)}warn(e,s,n,r){this.log(2,e,s,n,r)}error(e,s,n,r){this.log(3,e,s,n,r)}dataIn(e,s,n,r){this.info(e,`\u2192 ${s}`,n,r)}dataOut(e,s,n,r){this.info(e,`\u2190 ${s}`,n,r)}success(e,s,n,r){this.info(e,`\u2713 ${s}`,n,r)}failure(e,s,n,r){this.error(e,`\u2717 ${s}`,n,r)}timing(e,s,n,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${n}ms`})}happyPathError(e,s,n,r,o=""){let d=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=d?`${d[1].split("/").pop()}:${d[2]}`:"unknown",p={...n,location:u};return this.warn(e,`[HAPPY-PATH] ${s}`,p,r),o}},l=new xe;var mn={};function nn(){return typeof __dirname<"u"?__dirname:(0,R.dirname)((0,dt.fileURLToPath)(mn.url))}var rn=nn();function on(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let t=(0,R.join)((0,ke.homedir)(),".claude-mem"),e=(0,R.join)(t,"settings.json");try{if((0,V.existsSync)(e)){let s=JSON.parse((0,V.readFileSync)(e,"utf-8")),n=s.env??s;if(n.CLAUDE_MEM_DATA_DIR)return n.CLAUDE_MEM_DATA_DIR}}catch{}return t}var v=on(),Y=process.env.CLAUDE_CONFIG_DIR||(0,R.join)((0,ke.homedir)(),".claude"),ir=(0,R.join)(Y,"plugins","marketplaces","thedotmack"),an=(0,R.join)(v,"archives"),cn=(0,R.join)(v,"logs"),dn=(0,R.join)(v,"trash"),ln=(0,R.join)(v,"backups"),un=(0,R.join)(v,"modes"),ar=(0,R.join)(v,"settings.json"),lt=(0,R.join)(v,"claude-mem.db"),_n=(0,R.join)(v,"vector-db"),ut=(0,R.join)(v,"observer-sessions"),Fe=(0,R.basename)(ut),cr=(0,R.join)(Y,"settings.json"),dr=(0,R.join)(Y,"commands"),lr=(0,R.join)(Y,"CLAUDE.md");function _t(t){(0,V.mkdirSync)(t,{recursive:!0})}function mt(){return(0,R.join)(rn,"..")}var Q={dataDir:()=>v,workerPid:()=>(0,R.join)(v,"worker.pid"),serverBetaPid:()=>(0,R.join)(v,".server-beta.pid"),serverBetaPort:()=>(0,R.join)(v,".server-beta.port"),serverBetaRuntime:()=>(0,R.join)(v,".server-beta.runtime.json"),settings:()=>(0,R.join)(v,"settings.json"),database:()=>(0,R.join)(v,"claude-mem.db"),chroma:()=>(0,R.join)(v,"chroma"),combinedCerts:()=>(0,R.join)(v,"combined_certs.pem"),transcriptsConfig:()=>(0,R.join)(v,"transcript-watch.json"),transcriptsState:()=>(0,R.join)(v,"transcript-watch-state.json"),corpora:()=>(0,R.join)(v,"corpora"),supervisorRegistry:()=>(0,R.join)(v,"supervisor.json"),envFile:()=>(0,R.join)(v,".env"),logsDir:()=>cn,archives:()=>an,trash:()=>dn,backups:()=>ln,modes:()=>un,vectorDb:()=>_n,observerSessions:()=>ut};var bt=require("crypto");var Et=require("os"),gt=W(require("path"),1);var me=require("fs"),_e=W(require("path"),1),Z={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function pt(t){let e=_e.default.join(t,".git"),s;try{s=(0,me.statSync)(e)}catch(u){return u instanceof Error&&u.code!=="ENOENT"&&console.warn("[worktree] Unexpected error checking .git:",u),Z}if(!s.isFile())return Z;let n;try{n=(0,me.readFileSync)(e,"utf-8").trim()}catch(u){return console.warn("[worktree] Failed to read .git file:",u instanceof Error?u.message:String(u)),Z}let r=n.match(/^gitdir:\s*(.+)$/);if(!r)return Z;let i=r[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return Z;let a=i[1],c=_e.default.basename(t),d=_e.default.basename(a);return{isWorktree:!0,worktreeName:c,parentRepoPath:a,parentProjectName:d}}function Tt(t){return t==="~"||t.startsWith("~/")?t.replace(/^~/,(0,Et.homedir)()):t}function pn(t){if(!t||t.trim()==="")return l.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:t}),"unknown-project";let e=Tt(t),s=gt.default.basename(e);if(s===""){if(process.platform==="win32"){let r=t.match(/^([A-Z]):\\/i);if(r){let i=`drive-${r[1].toUpperCase()}`;return l.info("PROJECT_NAME","Drive root detected",{cwd:t,projectName:i}),i}}return l.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:t}),"unknown-project"}return s}function $e(t){let e=pn(t);if(!t)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let s=Tt(t),n=pt(s);if(n.isWorktree&&n.parentProjectName){let r=`${n.parentProjectName}/${e}`;return{primary:r,parent:n.parentProjectName,isWorktree:!0,allProjects:[n.parentProjectName,r]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}function pe(t,e,s){return(0,bt.createHash)("sha256").update([t||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}var En=[{name:"anthropic_key",re:/sk-ant-[A-Za-z0-9_-]{20,}/g},{name:"openai_key",re:/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g},{name:"github_token",re:/gh[pousr]_[A-Za-z0-9]{36,}/g},{name:"aws_access_key",re:/\bAKIA[0-9A-Z]{16}\b/g},{name:"jwt",re:/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g},{name:"bearer_token",re:/\bBearer\s+[A-Za-z0-9._-]{20,}/gi},{name:"named_secret",re:/\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([^\s"'&;]{6,})/gi}];function ft(t){let e=t;for(let{re:s}of En)e=e.replace(s,n=>{let r=n.search(/[:=]/);return r>-1&&/\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)/i.test(n.slice(0,r))?n.slice(0,r+1)+"[REDACTED]":"[REDACTED]"});return e}function $(t){return t==null?t:ft(t)}function Ee(t,e,s,n,r){if(!e){l.warn("DB","insertCaptureSnapshot: missing observationId \u2014 skipping");return}try{t.prepare(`
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
        llm_raw_type,
        captured_title,
        captured_subtitle,
        captured_narrative,
        captured_facts,
        captured_concepts,
        captured_why,
        captured_alternatives_rejected,
        captured_related_observation_ids,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s.memorySessionId,s.contentSessionId,s.promptNumber,$(s.userPrompt),$(s.priorAssistantMessage),s.toolName,$(s.toolInput),$(s.toolOutput),s.cwd,n.type,n.llmRawType,$(n.title),$(n.subtitle),$(n.narrative),n.facts,n.concepts,$(n.why),$(n.alternativesRejected),n.relatedObservationIds,r)}catch(o){l.warn("DB","insertCaptureSnapshot failed \u2014 observation persisted without snapshot",{observationId:e},o instanceof Error?o:void 0)}}function ge(t,e,s){return{memorySessionId:t,contentSessionId:e,promptNumber:s,userPrompt:null,priorAssistantMessage:null,toolName:null,toolInput:null,toolOutput:null,cwd:null}}function Te(t){return{type:t.type,llmRawType:t.pre_gate_type??null,title:t.title,subtitle:t.subtitle,narrative:t.narrative,facts:JSON.stringify(t.facts??[]),concepts:JSON.stringify(t.concepts??[]),why:t.why??null,alternativesRejected:t.alternatives_rejected??null,relatedObservationIds:t.related_observation_ids&&t.related_observation_ids.length>0?JSON.stringify(t.related_observation_ids):null}}function je(t){if(!t)return[];try{let e=JSON.parse(t);return Array.isArray(e)?e:[String(e)]}catch{return[t]}}function ht(t,e,s,n,r){if(e.length===0)return;l.debug("DB",`[observation-feedback] recording ${s} for ${e.length} observations`);let o=t.prepare(`
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
  `),a=Date.now(),c=r?JSON.stringify(r):null;t.transaction(u=>{for(let p of u)o.run(p,s,n??null,a,c),s==="memory_assist_helpful"&&i.run(p)})(e)}function be(t,e=30){let s={windowDays:e,helpful:0,notHelpful:0,bySource:{}},n=Date.now()-e*24*60*60*1e3,r=t.prepare(`
    SELECT signal_type, metadata
    FROM observation_feedback
    WHERE created_at_epoch >= ?
      AND signal_type IN ('memory_assist_helpful', 'memory_assist_not_helpful')
  `).all(n);for(let o of r){let i="unknown";if(o.metadata)try{i=JSON.parse(o.metadata).source||i}catch{}s.bySource[i]||(s.bySource[i]={helpful:0,notHelpful:0}),o.signal_type==="memory_assist_helpful"?(s.helpful+=1,s.bySource[i].helpful+=1):(s.notHelpful+=1,s.bySource[i].notHelpful+=1)}return l.debug("DB",`[observation-feedback] loaded feedback stats for ${e}d window (${r.length} rows)`),s}var M="claude";function gn(t){return t.trim().toLowerCase().replace(/\s+/g,"-")}function q(t){if(!t)return M;let e=gn(t);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:M}function St(t){let e=["claude","codex","cursor"];return[...t].sort((s,n)=>{let r=e.indexOf(s),o=e.indexOf(n);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:s.localeCompare(n)})}var fe=W(require("path"),1);function he(t){if(!t)return[];try{let e=JSON.parse(t);return Array.isArray(e)?e:[]}catch(e){return l.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:t?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Pe(t){return new Date(t).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Se(t){return new Date(t).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Xe(t){return new Date(t).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ot(t,e){return fe.default.isAbsolute(t)?fe.default.relative(e,t):t}function Rt(t,e,s){let n=he(t);if(n.length>0)return Ot(n[0],e);if(s){let r=he(s);if(r.length>0)return Ot(r[0],e)}return"General"}function Tn(t){return t?Math.ceil(t.length/4):0}function At(t,e){if(!t?.length)return 0;let s=new Set(t.map(i=>i.createdAtEpoch?Xe(i.createdAtEpoch):null).filter(i=>!!i)),n=[`This file has prior observations. ${e?`File: ${fe.default.basename(e)}.`:""}`.trim(),"- Already know enough? The timeline below may be all you need.","- Need details? get_observations([IDs])."],r=t.map(i=>{let a=i.createdAtEpoch?Se(i.createdAtEpoch):"",c=(i.title||"Untitled").replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim().slice(0,160);return`${i.observationId} ${a} ${i.type??"discovery"} ${c}`.trim()}),o=[...n,...Array.from(s).map(i=>`### ${i}`),...r].join(`
`);return Tn(o)}function K(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}function G(t){return t==null?null:JSON.stringify(t)}function yt(t){t.run(`
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
  `),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_created ON memory_assist_decisions(created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_source ON memory_assist_decisions(source, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_content_session ON memory_assist_decisions(content_session_id, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_project ON memory_assist_decisions(project, created_at_epoch DESC)");let e=t.query("PRAGMA table_info(memory_assist_decisions)").all();e.some(s=>s.name==="prompt_number")||t.run("ALTER TABLE memory_assist_decisions ADD COLUMN prompt_number INTEGER"),e.some(s=>s.name==="system_evidence_json")||t.run("ALTER TABLE memory_assist_decisions ADD COLUMN system_evidence_json TEXT"),e.some(s=>s.name==="selected_ids_json")||t.run("ALTER TABLE memory_assist_decisions ADD COLUMN selected_ids_json TEXT")}function Oe(t){return{id:t.id,source:t.source,status:t.status,reason:t.reason,timestamp:t.created_at_epoch,createdAtEpoch:t.created_at_epoch,updatedAtEpoch:t.updated_at_epoch,project:t.project??void 0,platformSource:t.platform_source??void 0,sessionDbId:t.session_db_id??void 0,contentSessionId:t.content_session_id??void 0,promptNumber:t.prompt_number??void 0,threshold:t.threshold??void 0,bestDistance:t.best_distance,worstDistance:t.worst_distance,candidateCount:t.candidate_count??void 0,selectedCount:t.selected_count??void 0,promptLength:t.prompt_length??void 0,filePath:t.file_path??void 0,message:t.message??void 0,estimatedInjectedTokens:t.estimated_injected_tokens??void 0,traceItems:K(t.trace_items_json,[]),selectedIds:K(t.selected_ids_json,[])||void 0,shadowRanking:K(t.shadow_ranking_json,null),systemVerdict:t.system_verdict,systemConfidence:t.system_confidence,systemReasons:K(t.system_reasons_json,[]),systemEvidence:K(t.system_evidence_json,null),userFeedback:t.user_feedback}}function Nt(t,e){let s=e.timestamp??Date.now();l.debug("DB",`[memory-assist-decisions] recording ${e.source}/${e.status} decision (${e.reason})`);let r=t.prepare(`
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
      selected_ids_json,
      shadow_ranking_json,
      system_verdict,
      system_confidence,
      system_reasons_json,
      system_evidence_json,
      user_feedback,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.source,e.status,e.reason,e.project??null,e.platformSource??null,e.sessionDbId??null,e.contentSessionId??null,e.promptNumber??null,e.threshold??null,e.bestDistance??null,e.worstDistance??null,e.candidateCount??null,e.selectedCount??null,e.promptLength??null,e.filePath??null,e.message??null,e.estimatedInjectedTokens??null,G(e.traceItems??[]),G(e.selectedIds??null),G(e.shadowRanking??null),e.systemVerdict??null,e.systemConfidence??null,G(e.systemReasons??[]),G(e.systemEvidence??null),e.userFeedback??null,s,s),o=bn(t,Number(r.lastInsertRowid));return l.debug("DB",`[memory-assist-decisions] stored decision ${o.id??"unknown"}`),o}function bn(t,e){let s=t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id = ?
  `).get(e);return s?Oe(s):null}function ee(t,e={}){let s=Math.min(Math.max(e.limit??20,1),1e4),n=[],r=[];e.windowDays&&(n.push("created_at_epoch >= ?"),r.push(Date.now()-e.windowDays*24*60*60*1e3)),e.source&&(n.push("source = ?"),r.push(e.source)),e.project&&(n.push("project = ?"),r.push(e.project)),e.contentSessionId&&(n.push("content_session_id = ?"),r.push(e.contentSessionId));let o=n.length>0?`WHERE ${n.join(" AND ")}`:"",a=t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    ${o}
    ORDER BY created_at_epoch DESC
    LIMIT ${s}
  `).all(...r).map(Oe);return l.debug("DB",`[memory-assist-decisions] loaded ${a.length} recent decisions (limit=${s})`),a}function It(t,e,s,n,r=Date.now()){let i=r-n,a=r+100;return t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND prompt_number = ?
      AND created_at_epoch >= ?
      AND created_at_epoch <= ?
    ORDER BY created_at_epoch DESC
  `).all(e,s,i,a).map(Oe)}function vt(t,e,s,n,r,o){t.prepare(`
    UPDATE memory_assist_decisions
    SET system_verdict = ?,
        system_confidence = ?,
        system_reasons_json = ?,
        system_evidence_json = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(s,n,G(r),G(o),Date.now(),e)}function Ct(t,e,s){t.prepare(`
    UPDATE memory_assist_decisions
    SET user_feedback = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(s,Date.now(),e)}function Mt(t,e,s,n){let r=s-n,o=t.prepare(`
    SELECT selected_ids_json
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND status = 'injected'
      AND prompt_number >= ?
      AND prompt_number < ?
  `).all(e,r,s),i=new Set;for(let a of o){let c=K(a.selected_ids_json,[]);for(let d of c)Number.isFinite(d)&&d>0&&i.add(d)}return i}function Ge(t,e){if(e.length===0)return[];let s=e.map(()=>"?").join(", ");return t.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id IN (${s})
  `).all(...e).map(Oe)}function te(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}function se(t){return t==null?null:JSON.stringify(t)}function Dt(t){t.run(`
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
  `),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_decision ON memory_assist_outcome_signals(decision_id, created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_session ON memory_assist_outcome_signals(content_session_id, created_at_epoch DESC)");let e=t.query("PRAGMA table_info(memory_assist_outcome_signals)").all();e.some(s=>s.name==="prompt_number")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN prompt_number INTEGER"),e.some(s=>s.name==="pending_message_id")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN pending_message_id INTEGER"),e.some(s=>s.name==="generated_observation_ids_json")||t.run("ALTER TABLE memory_assist_outcome_signals ADD COLUMN generated_observation_ids_json TEXT")}function Lt(t){return{id:t.id,decisionId:t.decision_id,pendingMessageId:t.pending_message_id,source:t.source,promptNumber:t.prompt_number??void 0,contentSessionId:t.content_session_id??void 0,sessionDbId:t.session_db_id??void 0,project:t.project??void 0,platformSource:t.platform_source??void 0,signalType:t.signal_type,toolName:t.tool_name,action:t.action,filePath:t.file_path,relatedFilePaths:te(t.related_file_paths_json,[]),concepts:te(t.concepts_json,[]),generatedObservationIds:te(t.generated_observation_ids_json,[]),metadata:te(t.metadata_json,{}),timestamp:t.created_at_epoch}}function wt(t,e){let s=e.timestamp??Date.now();l.debug("DB",`[memory-assist-outcomes] recording ${e.action} outcome for ${e.source??"unknown source"}`);let n=t.prepare(`
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
  `).run(e.decisionId??null,e.pendingMessageId??null,e.source??null,e.promptNumber??null,e.contentSessionId??null,e.sessionDbId??null,e.project??null,e.platformSource??null,e.signalType,e.toolName,e.action,e.filePath??null,se(e.relatedFilePaths??[]),se(e.concepts??[]),se(e.generatedObservationIds??[]),se(e.metadata??{}),s),r=t.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE id = ?
  `).get(Number(n.lastInsertRowid)),o=r?Lt(r):{...e,id:Number(n.lastInsertRowid),timestamp:s};return l.debug("DB",`[memory-assist-outcomes] stored outcome signal ${o.id??"unknown"}`),o}function Ut(t,e,s){return s.length===0?[]:t.transaction(()=>{let n=t.prepare(`
      SELECT id, generated_observation_ids_json
      FROM memory_assist_outcome_signals
      WHERE pending_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(e);if(!n)return l.debug("DB",`[memory-assist-outcomes] no outcome signal found for pending message ${e}`),[];let r=te(n.generated_observation_ids_json,[]),o=[...new Set([...r,...s])];return t.prepare(`
      UPDATE memory_assist_outcome_signals
      SET generated_observation_ids_json = ?
      WHERE id = ?
    `).run(se(o),n.id),l.debug("DB",`[memory-assist-outcomes] attached ${s.length} observations to pending message ${e}`),o})()}function xt(t,e){if(e.length===0)return{};let s=e.map(()=>"?").join(", "),n=t.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE decision_id IN (${s})
    ORDER BY created_at_epoch ASC
  `).all(...e),r=n.reduce((o,i)=>{let a=i.decision_id;return a==null||(o[a]||(o[a]=[]),o[a].push(Lt(i))),o},{});return l.debug("DB",`[memory-assist-outcomes] loaded ${n.length} outcome signals for ${e.length} decisions`),r}function He(t,e){if(!t)return e;try{return JSON.parse(t)}catch{return e}}var fn="__context__",hn="other";function Re(t){return{id:t.id,observationId:t.observation_id,pendingMessageId:t.pending_message_id,decisionId:t.decision_id,contentSessionId:t.content_session_id??void 0,sessionDbId:t.session_db_id??void 0,promptNumber:t.prompt_number??void 0,toolName:t.tool_name,action:t.action,filePath:t.file_path,createdAtEpoch:t.created_at_epoch,contextType:t.context_type??null,contextRef:He(t.context_ref_json??null,null)}}function kt(t){t.run(`
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
  `),t.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, ''))"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_observation ON observation_tool_origins(observation_id)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_pending ON observation_tool_origins(pending_message_id)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)")}function Be(t,e,s){if(s.length===0)return[];let n=t.prepare(`
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
  `).get(e);if(!n)return l.debug("DB",`memory-assist-origins: no outcome signal found for pending message ${e}`),[];let r=He(n.generated_observation_ids_json,[]),o=r.length>0?s.filter(u=>r.includes(u)):s;if(o.length===0)return l.debug("DB",`memory-assist-origins: no exact observation ids to attach for pending message ${e}`),[];let i=t.prepare(`
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
  `);t.transaction(u=>{for(let p of u)i.run(p,n.pending_message_id,n.decision_id,n.content_session_id,n.session_db_id,n.prompt_number,n.tool_name,n.action,n.file_path,n.created_at_epoch)})(o);let c=o.map(()=>"?").join(", "),d=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE pending_message_id = ?
      AND observation_id IN (${c})
    ORDER BY observation_id ASC
  `).all(e,...o);return l.debug("DB",`memory-assist-origins: attached ${d.length} observation origins for pending message ${e}`),d.map(Re)}function Ft(t,e){let s=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e);return s?Re(s):null}function $t(t,e,s,n,r=Date.now()){if(!Number.isFinite(e)||e<=0)return l.warn("DB",`memory-assist-origins: insertContextOrigin: invalid observationId=${e} \u2014 skipping`),null;let o=n.contentSessionId??n.content_session_id??null,i=n.sessionDbId??n.session_db_id??null,a=n.promptNumber??n.prompt_number??null;t.prepare(`
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
  `).run(e,o,i,a,fn,hn,r,s,JSON.stringify(n));let d=t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ? AND context_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(e,s);return d?Re(d):(l.debug("DB",`memory-assist-origins: insertContextOrigin: no row materialized for obs=${e} (already existed?)`),null)}function jt(t,e){return t.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id ASC
  `).all(e).map(Re)}function Pt(t,e={}){let s=e.limit??200,n=e.windowDays??30,r=Date.now()-n*24*60*60*1e3,o=t.prepare(`
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
  `).all(r,s),i=0,a=0;for(let c of o){let d=He(c.generated_observation_ids_json,[]);if(d.length===0||c.pending_message_id==null){a+=1;continue}let u=Be(t,c.pending_message_id,d);if(u.length>0){i+=u.length;continue}a+=1}return l.debug("DB",`memory-assist-origins: backfill complete: resolved=${i} unresolved=${a}`),{resolvedCount:i,unresolvedCount:a}}function Sn(t){return{id:t.id,project:t.project,source:t.source,semanticThreshold:t.semantic_threshold,injectLimit:t.inject_limit,minQueryLength:t.min_query_length,rankerId:t.ranker_id,createdAtEpoch:t.created_at_epoch,updatedAtEpoch:t.updated_at_epoch}}function Xt(t){t.run(`
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
  `),t.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_assist_calibration_scope ON memory_assist_calibration(COALESCE(project, ''), COALESCE(source, ''))")}function Gt(t){let e=t.prepare(`
    SELECT *
    FROM memory_assist_calibration
    ORDER BY updated_at_epoch DESC
  `).all(),s={global:null,byProject:{},bySource:{},byProjectAndSource:{}};for(let n of e){let r=Sn(n);if(!r.project&&!r.source){s.global??=r;continue}if(r.project&&r.source){s.byProjectAndSource[`${r.project}::${r.source}`]=r;continue}if(r.project){s.byProject[r.project]=r;continue}r.source&&(s.bySource[r.source]=r)}return l.debug("DB",`[memory-assist-calibration] loaded ${e.length} calibration rows`),s}function Ht(t,e,s,n){t.prepare(`PRAGMA table_info(${e})`).all().some(o=>o.name===s)||t.run(`ALTER TABLE ${e} ADD COLUMN ${s} ${n}`)}function Bt(t){t.run(`
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
  `),Ht(t,"observation_type_corrections","project","TEXT"),Ht(t,"observation_type_corrections","platform_source","TEXT"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_created ON observation_type_corrections(created_at_epoch DESC)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_project ON observation_type_corrections(project)"),t.run("CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_source ON observation_type_corrections(platform_source)")}function Wt(t,e){l.debug("DB",`[memory-assist-taxonomy] ${e.originalType} -> ${e.normalizedType} (${e.strategy}) in mode=${e.modeId}`),t.prepare(`
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
  `).run(e.modeId,e.originalType,e.normalizedType,e.fallbackType,e.strategy,e.correlationId??null,e.project??null,e.platformSource??null,Date.now())}function We(t,e=30,s={}){let n=Date.now()-e*24*60*60*1e3,r=["created_at_epoch >= ?"],o=[n];s.project&&(r.push("project = ?"),o.push(s.project)),s.platformSource&&(r.push("platform_source = ?"),o.push(s.platformSource));let i=t.prepare(`
    SELECT original_type, normalized_type, COUNT(*) AS count
    FROM observation_type_corrections
    WHERE ${r.join(" AND ")}
    GROUP BY original_type, normalized_type
    ORDER BY count DESC, original_type ASC
  `).all(...o),a={total:i.reduce((c,d)=>c+d.count,0),aliases:i.map(c=>({originalType:c.original_type,normalizedType:c.normalized_type,count:c.count}))};return l.debug("DB",`[memory-assist-taxonomy] loaded correction stats for ${e}d window (${a.total} corrections)`),a}var Vt=W(require("path"),1);var x=require("fs"),ne=require("path"),Ve=require("os"),P=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_CUSTOM_BASE_URL:"",CLAUDE_MEM_CUSTOM_API_KEY:"",CLAUDE_MEM_CUSTOM_MODEL:"",CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_CUSTOM_MAX_TOKENS:"100000",CLAUDE_MEM_CUSTOM_TEMPERATURE:"",CLAUDE_MEM_CUSTOM_MAX_OUTPUT_TOKENS:"",CLAUDE_MEM_DATA_DIR:(0,ne.join)((0,Ve.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,ne.join)((0,Ve.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_THRESHOLD:"0.35",CLAUDE_MEM_SEMANTIC_INJECT_SUMMARY_THRESHOLD:"0.65",CLAUDE_MEM_RECOMMENDER_PAUSED:"true",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){let s=this.get(e);return s==="true"||s===!0}static applyEnvOverrides(e){let s={...e};for(let n of Object.keys(this.DEFAULTS))process.env[n]!==void 0&&(s[n]=process.env[n]);return s}static loadFromFile(e){try{if(!(0,x.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,ne.dirname)(e);(0,x.existsSync)(a)||(0,x.mkdirSync)(a,{recursive:!0}),(0,x.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a instanceof Error?a.message:String(a))}return this.applyEnvOverrides(i)}let s=(0,x.readFileSync)(e,"utf-8"),n=JSON.parse(s),r=n;if(n.env&&typeof n.env=="object"){r=n.env;try{(0,x.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i instanceof Error?i.message:String(i))}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))r[i]!==void 0&&(o[i]=r[i]);return this.applyEnvOverrides(o)}catch(s){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,s instanceof Error?s.message:String(s)),this.applyEnvOverrides(this.getAllDefaults())}}};var Yt="awaiting content-reuse signal";function qt(){if(process.env.CLAUDE_MEM_RECOMMENDER_PAUSED!==void 0)return process.env.CLAUDE_MEM_RECOMMENDER_PAUSED==="true";try{let t=Vt.default.join(P.get("CLAUDE_MEM_DATA_DIR"),"settings.json");return P.loadFromFile(t).CLAUDE_MEM_RECOMMENDER_PAUSED==="true"}catch{return P.getBool("CLAUDE_MEM_RECOMMENDER_PAUSED")}}function L(t,e){return e<=0?null:Math.round(t/e*100)}function qe(t){return Math.round(t*10)/10}function On(t){let e=new Map;for(let s of t)s.status==="skipped"&&e.set(s.reason,(e.get(s.reason)??0)+1);return Array.from(e.entries()).sort((s,n)=>n[1]-s[1]||s[0].localeCompare(n[0])).slice(0,5).map(([s,n])=>({reason:s,count:n}))}function Rn(t){let e={likely_helped:0,unclear:0,likely_not_helped:0};for(let s of t)s.systemVerdict&&(e[s.systemVerdict]+=1);return e}function An(t,e){return t.length!==e.length?!1:t.every((s,n)=>s===e[n])}function yn(t,e){let s=new Set(t),n=new Set(e),r=new Set([...s,...n]);return r.size===0?100:[...s].filter(i=>n.has(i)).length/r.size*100}function Jt(t){let e=t.filter(i=>i.source==="semantic_prompt"&&i.shadowRanking?.experimentalSelectedObservationIds&&i.shadowRanking.productionSelectedObservationIds);if(e.length===0)return null;let s=0,n=0,r=0,o=0;for(let i of e){let a=[...i.shadowRanking?.productionSelectedObservationIds??[]].sort((d,u)=>d-u),c=[...i.shadowRanking?.experimentalSelectedObservationIds??[]].sort((d,u)=>d-u);if(An(a,c)&&(s+=1),n+=yn(a,c),i.systemVerdict==="likely_helped"){o+=1;let d=new Set((i.traceItems??[]).map(p=>p.observationId));c.some(p=>d.has(p))&&(r+=1)}}return{totalCompared:e.length,exactMatches:s,exactMatchRate:L(s,e.length),divergentSelections:e.length-s,avgSelectionOverlapRate:qe(n/e.length),likelyHelpedWithExperimentalOverlap:r,likelyHelpedWithExperimentalOverlapRate:L(r,o)}}function Nn(t,e){if(qt())return{kind:"paused",reason:Yt,slice:e};if(t.actionable<20)return{kind:"insufficient_data",reason:"Need at least 20 actionable decisions before making a threshold recommendation.",confidence:.35,suggestedDelta:null,actionable:t.actionable,slice:e};let s=t.topSkipReasons.find(o=>o.reason==="below_threshold")?.count??0,n=s>0&&s>=Math.ceil(t.actionable*.25),r=(t.shadowRanking?.divergentSelections??0)>0||(t.shadowRanking?.likelyHelpedWithExperimentalOverlap??0)>0;return(t.injectRate??0)>=40&&(t.likelyHelpedRate??0)<=10?{kind:"lower_threshold",reason:"Injection volume is high, but few recalls are being judged helpful. Tighten the threshold slightly.",confidence:.8,suggestedDelta:-.05,actionable:t.actionable,slice:e}:(t.injectRate??0)<=5&&n&&r?{kind:"raise_threshold",reason:"Below-threshold skips dominate this slice and shadow ranking shows missed alternatives. Loosen the threshold slightly.",confidence:.72,suggestedDelta:.05,actionable:t.actionable,slice:e}:{kind:"keep_threshold",reason:"This slice looks balanced enough to keep the current threshold for now.",confidence:.58,suggestedDelta:0,actionable:t.actionable,slice:e}}function Ae(t,e,s,n=null){let r=t.length,o=t.filter(N=>N.status==="injected").length,i=t.filter(N=>N.status==="skipped").length,a=t.filter(N=>N.status==="disabled").length,c=t.filter(N=>N.status==="error").length,d=o+i,u=Rn(t),p=u.likely_helped,b=t.filter(N=>N.userFeedback==="helpful").length,g=t.filter(N=>N.userFeedback==="not_helpful").length,h=t.reduce((N,D)=>N+(D.estimatedInjectedTokens??0),0),A=p,f=L(p,o),I=n??r,E=e==null?null:L(e,I),T={total:r,actionable:d,injected:o,injectRate:L(o,d),likelyHelped:p,likelyHelpedRate:L(p,d),userConfirmedHelpful:b,userConfirmedHelpfulRate:L(b,b+g),helped:A,checkedNoHelp:Math.max(o-A,0),disabled:a,errors:c,helpRate:f,topSkipReasons:On(t),verdicts:u,estimatedInjectedTokens:h,helpfulRecallsPer1kInjectedTokens:h>0?qe(p/h*1e3):null,injectedTokensPerLikelyHelpedRecall:p>0?qe(h/p):null,taxonomyCorrectionCount:e,taxonomyCorrectionRate:E,shadowRanking:Jt(t)};return{...T,recommendation:Nn(T,s)}}function Kt(t,e,s){let n=Date.now()-e*24*60*60*1e3,r=s?"SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? AND project = ?":"SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ?";return(s?t.prepare(r).get(n,s):t.prepare(r).get(n)).c}function Ye(t,e,s,n=null){return{source:t,...Ae(e,s,{scope:"source",key:t,source:t},n)}}function In(t,e,s,n=null){return{project:t,...Ae(e,s,{scope:"project",key:t,project:t},n)}}function vn(t,e,s,n){return{project:t,source:e,...Ae(s,n,{scope:"project_source",key:`${t}::${e}`,project:t,source:e})}}function Cn(t,e){let s=t.prepare(`
    SELECT s.signal_kind, COUNT(DISTINCT s.decision_id) as cnt
    FROM memory_implicit_signals s
    JOIN memory_assist_decisions d ON d.id = s.decision_id
    WHERE d.status = 'injected' AND d.created_at_epoch >= ?
    GROUP BY s.signal_kind
  `).all(e),n={};for(let g of s)n[g.signal_kind]=g.cnt;let o=t.prepare(`
    SELECT COUNT(*) as cnt FROM memory_assist_decisions
    WHERE status = 'injected' AND created_at_epoch >= ?
  `).get(e).cnt,a=t.prepare(`
    SELECT COUNT(DISTINCT d.id) as cnt
    FROM memory_assist_decisions d
    JOIN memory_implicit_signals s ON s.decision_id = d.id
    WHERE d.status = 'injected' AND d.created_at_epoch >= ?
  `).get(e).cnt,c=n.file_reuse??0,d=n.content_cited??0,u=n.no_overlap??0,p=Math.max(0,o-a),b=c+d;return{file_reuse:c,content_cited:d,no_overlap:u,not_yet_computed:p,implicitUseRate:L(b,a)}}function zt(t,e,s=30){let n=e.filter(S=>S.source==="semantic_prompt"),r=e.filter(S=>S.source==="semantic_summary"),o=e.filter(S=>S.source==="file_context"),i=e.filter(S=>S.status==="injected").length,a=e.filter(S=>S.status==="skipped").length,c=i+a,d=e.filter(S=>S.systemVerdict==="likely_helped").length,u=be(t,s),p=We(t,s),b=e.filter(S=>S.userFeedback==="helpful").length,g=e.filter(S=>S.userFeedback==="not_helpful").length,h=Date.now()-s*24*60*60*1e3,A=Kt(t,s),f=Cn(t,h),I=Ae(e,p.total,{scope:"global",key:"global"},A),E=[...new Set(e.map(S=>S.project).filter(S=>typeof S=="string"&&S.length>0))].sort((S,X)=>S.localeCompare(X)),T=Object.fromEntries(E.map(S=>{let X=e.filter(le=>le.project===S),we=We(t,s,{project:S}),it=Kt(t,s,S);return[S,In(S,X,we.total,it)]})),N=E.flatMap(S=>["semantic_prompt","semantic_summary","file_context"].map(X=>{let we=e.filter(le=>le.project===S&&le.source===X);return[`${S}::${X}`,vn(S,X,we,null)]})),D={semantic_prompt:Ye("semantic_prompt",n,null),semantic_summary:Ye("semantic_summary",r,null),file_context:Ye("file_context",o,null)},y=Date.now()-3600*1e3,C=e.filter(S=>S.createdAtEpoch>=y),j=C.filter(S=>S.status==="injected").length,_=C.filter(S=>S.status==="skipped").length,O=j+_,z=C.filter(S=>S.systemVerdict==="likely_helped").length,Le={sinceEpoch:y,totalDecisions:C.length,injectRate:L(j,O),likelyHelpedRate:L(z,O),injected:j,actionable:O},Ks={windowDays:s,totalDecisions:e.length,injected:i,injectRate:L(i,c),likelyHelped:d,likelyHelpedRate:L(d,c),recentTrend:Le,userConfirmedHelpfulRate:L(b,b+g),estimatedInjectedTokens:I.estimatedInjectedTokens,helpfulRecallsPer1kInjectedTokens:I.helpfulRecallsPer1kInjectedTokens,injectedTokensPerLikelyHelpedRecall:I.injectedTokensPerLikelyHelpedRecall,taxonomyCorrectionRate:I.taxonomyCorrectionRate,helped:d,checkedNoHelp:Math.max(i-d,0),helpRate:L(d,i),feedback:u,helpful:u.helpful,notHelpful:u.notHelpful,bySource:u.bySource,sourceStats:D,projectStats:T,projectSourceStats:Object.fromEntries(N),availableProjects:E,taxonomyCorrections:p,shadowRanking:Jt(n),recommendation:I.recommendation,implicitUseRate:f.implicitUseRate,implicitUseCounts:{file_reuse:f.file_reuse,content_cited:f.content_cited,no_overlap:f.no_overlap,not_yet_computed:f.not_yet_computed}};return l.debug("DB",`memory-assist-dashboard: built for ${s}d window using ${e.length} decisions across ${E.length} projects`),Ks}function U(t,e){return l.debug("SEARCH",`[MemoryAssistJudge] decision=${t.id??"new"} source=${t.source} status=${t.status} verdict=${e.verdict} confidence=${e.confidence.toFixed(2)}`),e}function re(){return{matchedTracePaths:[],usedOutcomes:[],ignoredOutcomes:[]}}function k(t){return t?t.replace(/\\/g,"/").trim().toLowerCase():null}function Mn(t){let e=new Set;for(let s of t.traceItems??[]){let n=k(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=k(r);o&&e.add(o)}}return e}function Dn(t){let e=new Set;for(let s of t){let n=k(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=k(r);o&&e.add(o)}}return e}function J(t,e){let s=new Set,n=k(t.filePath);n&&e.has(n)&&s.add(n);for(let r of t.relatedFilePaths??[]){let o=k(r);o&&e.has(o)&&s.add(o)}return[...s]}function Ln(t,e,s){let n=new Set(e.generatedObservationIds??[]),r=new Set(s),o=new Set;for(let i of t.traceItems??[]){if(n.has(i.observationId)){o.add(i.observationId);continue}let a=k(i.filePath);if(a&&r.has(a)){o.add(i.observationId);continue}(i.relatedFilePaths??[]).some(d=>{let u=k(d);return u!=null&&r.has(u)})&&o.add(i.observationId)}return[...o]}function wn(t,e){let s=new Set((e.concepts??[]).map(r=>r.trim().toLowerCase()).filter(Boolean));if(s.size===0)return 0;let n=new Set;for(let r of t.traceItems??[])for(let o of r.concepts??[]){let i=o.trim().toLowerCase();i&&s.has(i)&&n.add(i)}return n.size}function oe(t,e){return(t.generatedObservationIds??[]).some(s=>e.has(s))}function es(t){return new Set(t)}function ts(t,e){return e.size===0?!1:J(t,e).some(s=>e.has(s))}function B(t,e,s,n){let r=es(s);return r.size===0?!1:e.some(o=>o===t||!n.includes(o.action)||(o.timestamp??0)>(t.timestamp??0)?!1:ts(o,r))}function ss(t,e,s,n){let r=es(s);return r.size===0?!1:e.some(o=>o===t||!n.includes(o.action)||(o.timestamp??0)<(t.timestamp??0)?!1:ts(o,r))}function Un(t,e,s){return t.action==="browser"?"browser_follow_up":t.action==="command"?B(t,e,s,["edit","write"])?"terminal_follow_up":"other_follow_up":t.action==="read"?ss(t,e,s,["edit","write"])?"follow_up_read":"other_follow_up":(t.action==="edit"||t.action==="write")&&B(t,e,s,["read"])?"follow_up_edit":"other_follow_up"}function Qt(t,e,s,n,r,o){let i=Ln(t,e,n),a=wn(t,e),c=Un(e,s,n),d=(e.generatedObservationIds?.length??0)>0?"exact_observation_link":c==="follow_up_edit"||c==="terminal_follow_up"?"sequence_only":e.action==="browser"?"browser_only":n.length>0?"file_overlap":"no_overlap",u=d==="exact_observation_link"?o?"primary":"supporting":d==="sequence_only"?o?"supporting":"context":d==="file_overlap"&&o?"supporting":"context";return{outcomeId:e.id,pendingMessageId:e.pendingMessageId??null,action:e.action,toolName:e.toolName,filePath:e.filePath??null,timestamp:e.timestamp,matchedPaths:n,matchedTraceObservationIds:i,generatedObservationIds:e.generatedObservationIds??[],conceptOverlapCount:a,sequenceRole:c,signalSource:d,evidenceStrength:u,reason:r}}function Zt(t,e){return e.includes(t.action)}function H(t,e,s,n,r,o){let i=[],a=[];for(let c of e){let d=J(c,s);if(n(c,d)){i.push(Qt(t,c,e,d,r(c,d),!0));continue}a.push(Qt(t,c,e,d,o(c,d),!1))}return{matchedTracePaths:[...s],usedOutcomes:i,ignoredOutcomes:a}}function ns(t,e,s=t.userFeedback){if(s==="helpful")return U(t,{verdict:"likely_helped",confidence:.98,reasons:["User marked this memory assist as helpful."],evidence:re()});if(s==="not_helpful")return U(t,{verdict:"likely_not_helped",confidence:.98,reasons:["User marked this memory assist as not helpful."],evidence:re()});if(t.status!=="injected")return U(t,{verdict:"unclear",confidence:.4,reasons:["No memory was injected, so there is no direct adoption signal to judge."],evidence:re()});if(e.length===0)return U(t,{verdict:"unclear",confidence:.35,reasons:["No follow-up tool actions were recorded after this injection."],evidence:re()});if((t.traceItems?.length??0)===0&&(t.selectedCount??0)>0)return U(t,{verdict:"unclear",confidence:.3,reasons:["Summary injections have no file-path signals; adoption cannot be measured without explicit feedback."],evidence:re()});let r=t.promptNumber??null,o=new Set((t.traceItems??[]).map(_=>k(_.filePath)).filter(_=>!!_)),i=e.filter(_=>{if(_.action!=="read"||r==null||_.promptNumber==null||_.promptNumber!==r)return!0;let O=k(_.filePath);return O?!o.has(O):!0}),a=Mn(t),c=Dn(e),d=[...a].filter(_=>c.has(_)),u=d.length,p=new Set(d),b=e.filter(_=>J(_,p).length>0),g=b.filter(_=>_.action==="edit"||_.action==="write").length,h=i.filter(_=>_.action==="read"&&J(_,p).length>0).length,A=e.filter(_=>_.action==="browser").length,f=b.filter(_=>(_.generatedObservationIds?.length??0)>0).length,I=new Set((t.traceItems??[]).map(_=>_.observationId)),E=e.filter(_=>oe(_,I)),T=E.length,N=E.filter(_=>_.action==="edit"||_.action==="write").length,D=E.filter(_=>_.action==="read").length,y=b.filter(_=>(_.action==="edit"||_.action==="write")&&B(_,b,J(_,p),["read"])).length,C=b.filter(_=>_.action==="command"&&B(_,b,J(_,p),["edit","write"])).length;return N>0?U(t,{verdict:"likely_helped",confidence:y>0?.96:.9,reasons:[`${N} follow-up edit/write action${N===1?"":"s"} generated observations that were reused directly in the trace.`,...y>0?[`${y} of those edit/write action${y===1?"":"s"} followed a prior read on the same file.`]:[],...C>0?[`${C} same-target command follow-up${C===1?"":"s"} landed after an edit/write action.`]:[],"This is stronger evidence than plain file overlap because the exact generated observation linked back into the final trace."],evidence:H(t,e,p,(_,O)=>oe(_,I)&&Zt(_,["edit","write"]),(_,O)=>{let z=B(_,e,O,["read"]);return`Primary evidence: this ${_.action==="write"?"write":"edit"} generated observation content that was reused directly in the trace${z?", and it followed a same-target read":""}.`},(_,O)=>oe(_,I)?"Ignored by verdict because only edit/write actions count as adoption in this branch.":O.length>0?"Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.":"Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.")}):D>0?U(t,{verdict:"likely_helped",confidence:.78,reasons:[`${D} follow-up read action${D===1?"":"s"} generated observations that were reused directly in the trace.`,"This is stronger evidence than plain file overlap, but weaker than seeing the same target edited afterward."],evidence:H(t,e,p,_=>oe(_,I)&&_.action==="read",()=>"Primary evidence: this read generated observation content that was reused directly in the trace.",(_,O)=>oe(_,I)?"Ignored by verdict because only read-based exact trace reuse counted in this branch.":O.length>0?"Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.":"Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.")}):u>0&&g>0?U(t,{verdict:"likely_helped",confidence:T>0?.94:C>0?.91:f>0||y>0?.9:.88,reasons:[`Injected memory overlapped with ${u} file path${u===1?"":"s"} touched afterward.`,`${g} follow-up edit/write action${g===1?"":"s"} used those same files.`,...y>0?[`${y} of those edit/write action${y===1?"":"s"} followed a prior read on the same file.`]:[],...f>0?[`${f} matching follow-up action${f===1?"":"s"} produced exact linked observation${f===1?"":"s"}.`]:[],...T>0?[`${T} follow-up action${T===1?"":"s"} generated observations that were reused directly in the trace.`]:[],...C>0?[`${C} same-target command follow-up${C===1?"":"s"} landed after an edit/write action.`]:[]],evidence:H(t,e,p,(_,O)=>O.length>0&&Zt(_,["edit","write"]),(_,O)=>{let z=B(_,e,O,["read"]),Le=ss(_,e,O,["command"]);return`${(_.generatedObservationIds?.length??0)>0?"Primary":"Supporting"} evidence: it ${_.action==="write"?"wrote":"edited"} ${O.length===1?"the matched file":"matched files"}${(_.generatedObservationIds?.length??0)>0?` and generated ${_.generatedObservationIds.length} exact linked observation${_.generatedObservationIds.length===1?"":"s"}`:""}${z?", after a same-target read":""}${Le?", with a same-target command follow-up afterward":""}.`},(_,O)=>O.length>0?`Ignored by verdict because only edit/write overlap counted here${(_.generatedObservationIds?.length??0)>0?", even though this tool action generated exact linked observations":""}.`:`Ignored by verdict because it did not overlap with the injected memory paths${(_.generatedObservationIds?.length??0)>0?", even though it generated exact linked observations":""}.`)}):C>0?U(t,{verdict:"likely_helped",confidence:.83,reasons:[`${C} same-target command follow-up${C===1?"":"s"} landed after an edit/write action on the matched files.`,"That is weaker than direct trace reuse, but stronger than plain overlap because the command followed work on the same target."],evidence:H(t,e,p,(_,O)=>_.action==="command"&&O.length>0&&B(_,e,O,["edit","write"]),(_,O)=>`Supporting evidence: this command followed an edit/write on ${O.length===1?"the matched file":"matched files"} and stayed on the same target set.`,(_,O)=>O.length>0?"Ignored by verdict because only same-target command follow-ups counted in this branch.":"Ignored by verdict because it did not stay on the injected memory target set.")}):u>0&&h>0&&(h>=2||f>0||T>0)?U(t,{verdict:"likely_helped",confidence:T>0?.84:f>0?.78:.74,reasons:[`Injected memory overlapped with ${u} file path${u===1?"":"s"} revisited afterward.`,`${h} follow-up read action${h===1?"":"s"} revisited the same files.`,...f>0?[`${f} matching follow-up action${f===1?"":"s"} produced exact linked observation${f===1?"":"s"}.`]:[],...T>0?[`${T} follow-up action${T===1?"":"s"} generated observations that were reused directly in the trace.`]:[]],evidence:H(t,e,p,(_,O)=>O.length>0&&_.action==="read",(_,O)=>`${(_.generatedObservationIds?.length??0)>0?"Primary":"Supporting"} evidence: it reread ${O.length===1?"the matched file":"matched files"}${(_.generatedObservationIds?.length??0)>0?` and generated ${_.generatedObservationIds.length} exact linked observation${_.generatedObservationIds.length===1?"":"s"}`:""}.`,(_,O)=>O.length>0?`Ignored by verdict because only read overlap counted in this branch${(_.generatedObservationIds?.length??0)>0?", even though this tool action generated exact linked observations":""}.`:`Ignored by verdict because it did not overlap with the injected memory paths${(_.generatedObservationIds?.length??0)>0?", even though it generated exact linked observations":""}.`)}):A>0?U(t,{verdict:"unclear",confidence:.46,reasons:["The follow-up signal was mostly browser/UI activity, which is weaker evidence than file overlap."],evidence:H(t,e,p,_=>_.action==="browser",()=>"Context-only evidence: browser/UI follow-up was the only available signal.",(_,O)=>O.length>0?"Ignored by verdict because browser/UI activity took precedence in this branch.":"Ignored by verdict because it did not overlap with the injected memory paths.")}):U(t,{verdict:"likely_not_helped",confidence:.62,reasons:["The injection was not followed by related file overlap or a concrete follow-up action."],evidence:H(t,e,p,()=>!1,()=>"Unused.",(_,O)=>O.length>0?"Ignored by verdict because there was overlap, but no qualifying follow-up action.":"Ignored by verdict because it did not overlap with the injected memory paths.")})}function ye(t){return t?t.replace(/\\/g,"/").trim().toLowerCase():null}function xn(t){let e=new Set,s=ye(t.filePath);s&&e.add(s);for(let n of t.relatedFilePaths??[]){let r=ye(n);r&&e.add(r)}return e}function kn(t){let e=new Set;for(let s of t.traceItems??[]){let n=ye(s.filePath);n&&e.add(n);for(let r of s.relatedFilePaths??[]){let o=ye(r);o&&e.add(o)}}return e}function Je(t){let e=t[0];for(let s=1;s<t.length;s++)t[s].createdAtEpoch>e.createdAtEpoch&&(e=t[s]);return e}function Fn(t,e){let s=null,n=1/0;for(let r of t)if(r.createdAtEpoch<=e){let o=e-r.createdAtEpoch;o<n&&(s=r,n=o)}return s??Je(t)}function $n(t,e){return{customTitle:t,platformSource:e?q(e):void 0}}var Ne=class{db;constructor(e=lt){e instanceof Ke.Database?this.db=e:(e!==":memory:"&&_t(v),this.db=new Ke.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.db.run("PRAGMA journal_size_limit = 4194304")),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.ensureObservationFeedbackTable(),this.ensureMemoryAssistTables(),this.createObservationsFTSIndex(),this.addObservationDecisionDNAFields(),this.addCaptureSnapshotTables(),this.addObservationContextOriginFields(),this.addMcpInvocationsTable(),this.addMemoryImplicitSignalsTable(),this.addLlmRawTypeColumn(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn()}createObservationsFTSIndex(){let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0;try{e||(this.db.run(`
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
        `),this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')"),l.debug("DB","SessionStore: Created observations_fts virtual table, sync triggers, and backfilled existing rows"))}catch(s){l.warn("DB","FTS5 not available, observations_fts index skipped",{},s)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()),l.debug("DB","SessionStore: Observations FTS5 index ensured")}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(39),n=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="worker_pid");if(!(e&&!n)){if(n)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),l.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(r){l.warn("DB","Failed to drop worker_pid column from pending_messages",{},r instanceof Error?r:new Error(String(r)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(38),s=this.db.query("PRAGMA table_info(pending_messages)").all(),n=new Set(s.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>n.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),l.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(38,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),l.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(38,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),l.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),l.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1&&n.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),l.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}l.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),l.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let n=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!n||n.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}l.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `);let n=`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `,r=`
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
    `;try{this.db.run(n),this.db.run(r)}catch(o){o instanceof Error?l.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):l.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}l.debug("DB","Creating pending_messages table"),this.db.run(`
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;l.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,n=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),c=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:c?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),l.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(l.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};n("sdk_sessions","claude_session_id","content_session_id")&&s++,n("sdk_sessions","sdk_session_id","memory_session_id")&&s++,n("pending_messages","claude_session_id","content_session_id")&&s++,n("observations","sdk_session_id","memory_session_id")&&s++,n("session_summaries","sdk_session_id","memory_session_id")&&s++,n("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?l.debug("DB",`Successfully renamed ${s} session ID columns`):l.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),l.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;l.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let n=this.db.query("PRAGMA table_info(observations)").all().some(h=>h.name==="metadata"),r=n?`,
        metadata TEXT`:"",o=n?", metadata":"",i=`
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
        created_at_epoch INTEGER NOT NULL${r},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,a=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${o}
      FROM observations
    `,c=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,d=`
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
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let u=`
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
    `,p=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,b=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,g=`
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
    `;try{this.recreateObservationsWithCascade(i,a,c,d),this.recreateSessionSummariesWithCascade(u,p,b,g),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),l.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(h){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),h instanceof Error?h:new Error(String(h))}}recreateObservationsWithCascade(e,s,n,r){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(n),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(r)}recreateSessionSummariesWithCascade(e,s,n,r){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(n),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(r)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),l.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),l.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${M}'`),l.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${M}'
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensureMemoryAssistTables(){yt(this.db),Dt(this.db),kt(this.db),Xt(this.db),Bt(this.db)}addObservationDecisionDNAFields(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29),s=this.db.query("PRAGMA table_info(observations)").all(),n=new Set(s.map(a=>a.name)),r=!n.has("why"),o=!n.has("alternatives_rejected"),i=!n.has("related_observation_ids");if(!(e&&!r&&!o&&!i)){r&&this.db.run("ALTER TABLE observations ADD COLUMN why TEXT"),o&&this.db.run("ALTER TABLE observations ADD COLUMN alternatives_rejected TEXT"),i&&this.db.run("ALTER TABLE observations ADD COLUMN related_observation_ids TEXT");try{this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&(this.db.query("PRAGMA table_info(observations_fts)").all().some(u=>u.name==="why")||(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_fts"),this.db.run(`
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
          `),this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')"),l.debug("DB","SessionStore: rebuilt observations_fts with why + alternatives_rejected columns")))}catch(a){l.warn("DB","SessionStore: FTS5 extension for V29 skipped",{},a instanceof Error?a:void 0)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString()),l.debug("DB","SessionStore: migration V29 complete (why/alternatives_rejected/related_observation_ids)")}}addCaptureSnapshotTables(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(30),s=this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observation_capture_snapshots','observation_rubric_scores')").all(),n=new Set(s.map(i=>i.name)),r=!n.has("observation_capture_snapshots"),o=!n.has("observation_rubric_scores");e&&!r&&!o||(r&&(this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_rubric_obs ON observation_rubric_scores(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_rubric_scored ON observation_rubric_scores(scored_at_epoch DESC)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString()),l.debug("DB","SessionStore: migration V30 complete (observation_capture_snapshots + observation_rubric_scores)"))}addObservationContextOriginFields(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(observation_tool_origins)").all();if(s.length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString());return}let n=new Set(s.map(i=>i.name)),r=!n.has("context_type"),o=!n.has("context_ref_json");e&&!r&&!o||(r&&this.db.run("ALTER TABLE observation_tool_origins ADD COLUMN context_type TEXT"),o&&this.db.run("ALTER TABLE observation_tool_origins ADD COLUMN context_ref_json TEXT"),this.db.run("DROP INDEX IF EXISTS idx_observation_tool_origins_observation_pending"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, ''))"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),l.debug("DB","SessionStore: migration V31 complete (context_type + context_ref_json on observation_tool_origins)"))}addMcpInvocationsTable(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_invocations'").get();e&&s||(this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_summary TEXT,
        result_status TEXT NOT NULL,
        error_message TEXT,
        duration_ms INTEGER,
        invoked_at_epoch INTEGER NOT NULL
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_mcp_invocations_tool_time ON mcp_invocations(tool_name, invoked_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_mcp_invocations_time ON mcp_invocations(invoked_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString()),l.debug("DB","SessionStore: migration V32 complete (mcp_invocations table)"))}addMemoryImplicitSignalsTable(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_implicit_signals'").get();e&&s||(this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_implicit_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL,
        observation_id INTEGER NOT NULL,
        signal_kind TEXT NOT NULL CHECK(signal_kind IN ('file_reuse', 'content_cited', 'no_overlap')),
        evidence TEXT,
        confidence REAL,
        computed_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (decision_id) REFERENCES memory_assist_decisions(id),
        FOREIGN KEY (observation_id) REFERENCES observations(id)
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_mis_decision ON memory_implicit_signals(decision_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_mis_obs ON memory_implicit_signals(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_mis_kind_time ON memory_implicit_signals(signal_kind, computed_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString()),l.debug("DB","SessionStore: migration V33 complete (memory_implicit_signals table)"))}addLlmRawTypeColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34))return;this.db.prepare("PRAGMA table_info(observation_capture_snapshots)").all().some(n=>n.name==="llm_raw_type")||this.db.run("ALTER TABLE observation_capture_snapshots ADD COLUMN llm_raw_type TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString()),l.debug("DB","SessionStore: migration V34 complete (llm_raw_type column on observation_capture_snapshots)")}getUncomputedDecisionsForSession(e,s=50){return this.db.prepare(`
      SELECT d.id as decision_id, d.trace_items_json, d.created_at_epoch
      FROM memory_assist_decisions d
      WHERE d.content_session_id = ?
        AND d.status = 'injected'
        AND NOT EXISTS (
          SELECT 1 FROM memory_implicit_signals s WHERE s.decision_id = d.id
        )
      ORDER BY d.created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}insertImplicitSignal(e,s,n,r,o,i){this.db.prepare(`
      INSERT INTO memory_implicit_signals
        (decision_id, observation_id, signal_kind, evidence, confidence, computed_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,s,n,r,o,i)}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(n=>n.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),n=s.some(i=>i.name==="agent_type"),r=s.some(i=>i.name==="agent_id");n||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(c=>c.name==="agent_type"),a=o.some(c=>c.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        DELETE FROM pending_messages
         WHERE id IN (
           SELECT id
             FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY content_session_id, tool_use_id
                        ORDER BY CASE status
                          WHEN 'processing' THEN 0
                          WHEN 'pending' THEN 1
                          ELSE 2
                        END, id
                      ) AS duplicate_rank
                 FROM pending_messages
                WHERE tool_use_id IS NOT NULL
             )
            WHERE duplicate_rank > 1
           )
      `),this.db.run(`
        -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
        -- only for rows that came from a concrete tool-use event.
        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
        ON pending_messages(content_session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()),this.db.run("COMMIT")}catch(r){throw this.db.run("ROLLBACK"),r}}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(36))return;let s=this.db.query("PRAGMA table_info(observations)").all(),n=s.some(o=>o.name==="memory_session_id"),r=s.some(o=>o.name==="content_hash");if(!n||!r){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(36,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        DELETE FROM observations
         WHERE id NOT IN (
           SELECT MIN(id) FROM observations
            GROUP BY memory_session_id, content_hash
         )
      `),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(36,new Date().toISOString()),this.db.run("COMMIT")}catch(o){throw this.db.run("ROLLBACK"),o}}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),l.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(37,new Date().toISOString())}updateMemorySessionId(e,s){this.db.prepare(`
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
      `).run(s,e),l.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:s}))}getRecentSummaries(e,s=10){return this.db.prepare(`
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
        COALESCE(s.platform_source, '${M}') as platform_source,
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
        COALESCE(s.platform_source, '${M}') as platform_source,
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
        COALESCE(s.platform_source, '${M}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let s=e?q(e):void 0,n=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,r=[Fe];return s&&(n+=" AND COALESCE(platform_source, ?) = ?",r.push(M,s)),n+=" ORDER BY project ASC",this.db.prepare(n).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${M}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${M}'), project
      ORDER BY latest_epoch DESC
    `).all(Fe),s=[],n=new Set,r={};for(let i of e){let a=q(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),n.has(i.project)||(n.add(i.project),s.push(i.project))}let o=St(Object.keys(r));return{projects:s,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${M}') as platform_source
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
    `).get(e)||null}getObservationOrigin(e){return Ft(this.db,e)}recordObservationFeedback(e,s,n,r){ht(this.db,e,s,n,r)}getObservationFeedbackStats(e=30){return be(this.db,e)}recordMemoryAssistDecision(e){let s=e.contentSessionId?this.getPromptNumberFromUserPrompts(e.contentSessionId):void 0,n=e.promptNumber??(s&&s>0?s:void 0),r=Nt(this.db,{...e,promptNumber:n});return this.refreshMemoryAssistDecisionVerdict(r.id)??r}getRecentMemoryAssistDecisions(e={}){return ee(this.db,e)}getRecentlyInjectedIds(e,s,n){return Mt(this.db,e,s,n)}recordMemoryAssistOutcomeSignal(e){let s=e.promptNumber??(typeof e.metadata?.promptNumber=="number"?e.metadata.promptNumber:void 0),n=e.decisionId??this.resolveMemoryAssistDecisionId({...e,promptNumber:s}),r=wt(this.db,{...e,promptNumber:s,decisionId:n});return n&&this.refreshMemoryAssistDecisionVerdict(n),r}relinkOrphanOutcomeSignal(e){let s=this.db.prepare(`
      SELECT content_session_id, prompt_number, file_path, related_file_paths_json,
             concepts_json, tool_name, action, signal_type, created_at_epoch
      FROM memory_assist_outcome_signals
      WHERE id = ? AND decision_id IS NULL
    `).get(e);if(!s||!s.content_session_id||!s.prompt_number)return null;let n=s.related_file_paths_json?JSON.parse(s.related_file_paths_json):[],r=s.concepts_json?JSON.parse(s.concepts_json):[],o={contentSessionId:s.content_session_id,promptNumber:s.prompt_number,filePath:s.file_path,relatedFilePaths:n,concepts:r,toolName:s.tool_name,action:s.action,signalType:s.signal_type,timestamp:s.created_at_epoch},i=this.resolveMemoryAssistDecisionId(o);return i?(this.db.prepare(`
      UPDATE memory_assist_outcome_signals SET decision_id = ? WHERE id = ?
    `).run(i,e),i):null}listOrphanOutcomeSignalIds(e){return this.db.prepare(`
      SELECT id FROM memory_assist_outcome_signals
      WHERE decision_id IS NULL
        AND content_session_id IS NOT NULL
        AND prompt_number IS NOT NULL
        AND created_at_epoch >= ?
      ORDER BY created_at_epoch ASC
    `).all(e).map(n=>n.id)}attachGeneratedObservationsToOutcomeSignal(e,s){if(s.length===0)return null;let n=Ut(this.db,e,s);if(n.length===0)return null;let r=this.db.prepare(`
      SELECT *
      FROM memory_assist_outcome_signals
      WHERE pending_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(e);if(!r)return null;let o={id:r.id,decisionId:r.decision_id,pendingMessageId:e,source:r.source,promptNumber:r.prompt_number??void 0,contentSessionId:r.content_session_id??void 0,sessionDbId:r.session_db_id??void 0,project:r.project??void 0,platformSource:r.platform_source??void 0,signalType:r.signal_type,toolName:r.tool_name,action:r.action,filePath:r.file_path,relatedFilePaths:r.related_file_paths_json?JSON.parse(r.related_file_paths_json):[],concepts:r.concepts_json?JSON.parse(r.concepts_json):[],generatedObservationIds:n,metadata:r.metadata_json?JSON.parse(r.metadata_json):{},timestamp:r.created_at_epoch};return o.decisionId&&this.refreshMemoryAssistDecisionVerdict(o.decisionId),o}attachObservationOriginsToPendingMessage(e,s){return Be(this.db,e,s)}insertContextOrigin(e,s,n,r){return $t(this.db,e,s,n,r)}getObservationOrigins(e){return jt(this.db,e)}resolveMemoryAssistDecisionId(e){if(!e.contentSessionId||!e.promptNumber)return null;let s=e.timestamp??Date.now(),n=It(this.db,e.contentSessionId,e.promptNumber,900*1e3,s);if(n.length===0)return null;let r=n.filter(c=>c.status==="injected");if(r.length===0)return null;let o=xn(e),i=r.filter(c=>{if(c.source!=="file_context"||o.size===0)return!1;let d=kn(c);return[...o].some(u=>d.has(u))});if(i.length>0)return Je(i).id;let a=r.filter(c=>c.source==="semantic_prompt");return a.length>0?Je(a).id:Fn(r,s).id}attachMemoryAssistDecisionFeedback(e,s){Ct(this.db,e,s),this.refreshMemoryAssistDecisionVerdict(e,s)}getMemoryAssistDashboard(e=30){let s=ee(this.db,{limit:1e4,windowDays:e});return zt(this.db,s,e)}backfillRecentFileContextTokenEstimates(e={}){let s=ee(this.db,{limit:e.limit??200,windowDays:e.windowDays??30,source:"file_context"}),n=0;for(let r of s){if(r.status!=="injected"||(r.estimatedInjectedTokens??0)>0)continue;let o=At(r.traceItems,r.filePath);o<=0||(this.db.prepare(`
        UPDATE memory_assist_decisions
        SET estimated_injected_tokens = ?,
            updated_at_epoch = ?
        WHERE id = ?
      `).run(o,Date.now(),r.id),n+=1)}return l.debug("DB",`memory-assist-decisions: backfilled file-context token estimates for ${n} decisions`),{updatedCount:n}}backfillRecentMemoryAssistEvidence(e={}){return ee(this.db,{limit:e.limit??200,windowDays:e.windowDays??30}).map(r=>this.refreshMemoryAssistDecisionVerdict(r.id)??r)}backfillRecentObservationOrigins(e={}){return Pt(this.db,e)}getMemoryAssistCalibrationSnapshot(){return Gt(this.db)}recordObservationTypeCorrection(e){Wt(this.db,e)}refreshMemoryAssistDecisionVerdict(e,s){let[n]=Ge(this.db,[e]);if(!n)return null;let r=xt(this.db,[e]),o=ns(n,r[e]??[],s);return vt(this.db,e,o.verdict,o.confidence,o.reasons,o.evidence),Ge(this.db,[e])[0]??null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o,type:i,concepts:a,files:c}=s,d=n==="relevance",u=d?"":`ORDER BY created_at_epoch ${n==="date_asc"?"ASC":"DESC"}`,p=r?`LIMIT ${r}`:"",b=e.map(()=>"?").join(","),g=[...e],h=[];if(o&&(h.push("project = ?"),g.push(o)),i)if(Array.isArray(i)){let T=i.map(()=>"?").join(",");h.push(`type IN (${T})`),g.push(...i)}else h.push("type = ?"),g.push(i);if(a){let T=Array.isArray(a)?a:[a],N=T.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");g.push(...T),h.push(`(${N.join(" OR ")})`)}if(c){let T=Array.isArray(c)?c:[c],N=T.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");T.forEach(D=>{g.push(`%${D}%`,`%${D}%`)}),h.push(`(${N.join(" OR ")})`)}let A=h.length>0?`WHERE id IN (${b}) AND ${h.join(" AND ")}`:`WHERE id IN (${b})`,I=this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ${u}
      ${p}
    `).all(...g);if(!d)return I;let E=new Map(I.map(T=>[T.id,T]));return e.map(T=>E.get(T)).filter(T=>!!T)}getPriorObservationsForFiles(e,s,n=3){if(e.length===0)return[];let r=e.map(()=>`(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR
          EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))`).join(" OR "),o=e.flatMap(a=>[`%${a}%`,`%${a}%`]);return this.db.prepare(`
      SELECT type, title, created_at_epoch
      FROM observations
      WHERE (${r}) AND created_at_epoch < ?
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(...o,s,n).map(a=>`${new Date(a.created_at_epoch).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} [${a.type}] ${(a.title??"").slice(0,100)}`)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),r=new Set,o=new Set;for(let i of n)je(i.files_read).forEach(a=>r.add(a)),je(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${M}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${M}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,n,r,o){let i=new Date,a=i.getTime(),c=$n(r,o),d=c.platformSource??M,u=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(u){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(s,e),c.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(c.customTitle,e),c.platformSource){let b=u.platform_source?.trim()?q(u.platform_source):void 0;if(!b)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(c.platformSource,e);else if(b!==c.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${b}, received=${c.platformSource}`)}return u.id}return this.db.prepare(`
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
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,n,r,o=0,i,a,c){let d=i??Date.now(),u=new Date(d).toISOString(),p=pe(e,n.title,n.narrative),g=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
       generated_by_model, metadata, why, alternatives_rejected, related_observation_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, created_at_epoch
    `).get(e,s,n.type,n.title,n.subtitle,JSON.stringify(n.facts),n.narrative,JSON.stringify(n.concepts),JSON.stringify(n.files_read),JSON.stringify(n.files_modified),r||null,o,n.agent_type??null,n.agent_id??null,p,u,d,a||null,n.metadata??null,n.why??null,n.alternatives_rejected??null,n.related_observation_ids&&n.related_observation_ids.length>0?JSON.stringify(n.related_observation_ids):null);if(g)return Ee(this.db,g.id,c??ge(e,null,r??null),Te(n),d),{id:g.id,createdAtEpoch:g.created_at_epoch};let h=this.db.prepare("SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?").get(e,p);if(!h)throw new Error(`storeObservation: ON CONFLICT without existing row for content_hash=${p}`);return{id:h.id,createdAtEpoch:h.created_at_epoch}}storeSummary(e,s,n,r,o=0,i){let a=i??Date.now(),c=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,r||null,o,c,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,n,r,o,i=0,a,c,d){let u=a??Date.now(),p=new Date(u).toISOString();return this.db.transaction(()=>{let g=[],h=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),A=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?"),f=d??ge(e,null,o??null);for(let E of n){let T=pe(e,E.title,E.narrative),N=h.get(e,s,E.type,E.title,E.subtitle,JSON.stringify(E.facts),E.narrative,JSON.stringify(E.concepts),JSON.stringify(E.files_read),JSON.stringify(E.files_modified),o||null,i,E.agent_type??null,E.agent_id??null,T,p,u,c||null,E.why??null,E.alternatives_rejected??null,E.related_observation_ids&&E.related_observation_ids.length>0?JSON.stringify(E.related_observation_ids):null);if(N){g.push(N.id),Ee(this.db,N.id,f,Te(E),u);continue}let D=A.get(e,T);if(!D)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${T}`);g.push(D.id)}let I=null;if(r){let T=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,p,u);I=Number(T.lastInsertRowid)}return{observationIds:g,summaryId:I,createdAtEpoch:u}})()}storeObservationsAndMarkComplete(e,s,n,r,o,i,a,c=0,d,u,p){let b=d??Date.now(),g=new Date(b).toISOString();return this.db.transaction(()=>{let A=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),I=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?"),E=p??ge(e,null,a??null);for(let y of n){let C=pe(e,y.title,y.narrative),j=f.get(e,s,y.type,y.title,y.subtitle,JSON.stringify(y.facts),y.narrative,JSON.stringify(y.concepts),JSON.stringify(y.files_read),JSON.stringify(y.files_modified),a||null,c,y.agent_type??null,y.agent_id??null,C,g,b,u||null,y.why??null,y.alternatives_rejected??null,y.related_observation_ids&&y.related_observation_ids.length>0?JSON.stringify(y.related_observation_ids):null);if(j){A.push(j.id),Ee(this.db,j.id,E,Te(y),b);continue}let _=I.get(e,C);if(!_)throw new Error(`storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${C}`);A.push(_.id)}let T;if(r){let C=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,a||null,c,g,b);T=Number(C.lastInsertRowid)}if(this.db.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND status = 'processing'
      `).run(o).changes!==1)throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${o}`);return{observationIds:A,summaryId:T,createdAtEpoch:b}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o}=s,i=n==="relevance",a=i?"":`ORDER BY created_at_epoch ${n==="date_asc"?"ASC":"DESC"}`,c=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),u=[...e],p=o?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;o&&u.push(o);let g=this.db.prepare(`
      SELECT * FROM session_summaries
      ${p}
      ${a}
      ${c}
    `).all(...u);if(!i)return g;let h=new Map(g.map(A=>[A.id,A]));return e.map(A=>h.get(A)).filter(A=>!!A)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:n="date_desc",limit:r,project:o}=s,i=n==="relevance",a=i?"":`ORDER BY up.created_at_epoch ${n==="date_asc"?"ASC":"DESC"}`,c=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),u=[...e],p=o?"AND s.project = ?":"";o&&u.push(o);let g=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${p}
      ${a}
      ${c}
    `).all(...u);if(!i)return g;let h=new Map(g.map(A=>[A.id,A]));return e.map(A=>h.get(A)).filter(A=>!!A)}getTimelineAroundTimestamp(e,s=10,n=10,r){return this.getTimelineAroundObservation(null,e,s,n,r)}getTimelineAroundObservation(e,s,n=10,r=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],c,d;if(e!==null){let f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,I=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let E=this.db.prepare(f).all(e,...a,n+1),T=this.db.prepare(I).all(e,...a,r+1);if(E.length===0&&T.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,d=T.length>0?T[T.length-1].created_at_epoch:s}catch(E){return E instanceof Error?l.error("DB","Error getting boundary observations",{project:o},E):l.error("DB","Error getting boundary observations with non-Error",{},new Error(String(E))),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,I=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let E=this.db.prepare(f).all(s,...a,n),T=this.db.prepare(I).all(s,...a,r+1);if(E.length===0&&T.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,d=T.length>0?T[T.length-1].created_at_epoch:s}catch(E){return E instanceof Error?l.error("DB","Error getting boundary timestamps",{project:o},E):l.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(E))),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,p=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,g=this.db.prepare(u).all(c,d,...a),h=this.db.prepare(p).all(c,d,...a),A=this.db.prepare(b).all(c,d,...a);return{observations:g,sessions:h.map(f=>({id:f.id,memory_session_id:f.memory_session_id,project:f.project,request:f.request,completed:f.completed,next_steps:f.next_steps,created_at:f.created_at,created_at_epoch:f.created_at_epoch})),prompts:A.map(f=>({id:f.id,content_session_id:f.content_session_id,prompt_number:f.prompt_number,prompt_text:f.prompt_text,project:f.project,created_at:f.created_at,created_at_epoch:f.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
    `).run(s,n,e,M,o.toISOString(),o.getTime()),l.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}getObservationRetrievalContext(e){let s=new Map;if(e.length===0)return s;let n=e.map(()=>"?").join(","),r=this.db.prepare(`
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
    `).run(e.content_session_id,e.memory_session_id,e.project,q(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
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
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var ie=require("fs"),Ie=require("path");var w=class t{static instance=null;activeMode=null;modesDir;constructor(){let e=mt(),s=[(0,Ie.join)(e,"modes"),(0,Ie.join)(e,"..","plugin","modes")],n=s.find(r=>(0,ie.existsSync)(r));this.modesDir=n||s[0]}static getInstance(){return t.instance||(t.instance=new t),t.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let n={...e};for(let r in s){let o=s[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?n[r]=this.deepMerge(i,o):n[r]=o}return n}loadModeFile(e){let s=(0,Ie.join)(this.modesDir,`${e}.json`);if(!(0,ie.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let n=(0,ie.readFileSync)(s,"utf-8");return JSON.parse(n)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let c=this.loadModeFile(e);return this.activeMode=c,l.debug("SYSTEM",`Loaded mode: ${c.name} (${e})`,void 0,{types:c.observation_types.map(d=>d.id),concepts:c.observation_concepts.map(d=>d.id)}),c}catch(c){if(c instanceof Error?l.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:c.message}):l.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(c)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:n,overrideId:r}=s,o;try{o=this.loadMode(n)}catch(c){c instanceof Error?l.warn("WORKER",`Parent mode '${n}' not found for ${e}, falling back to 'code'`,{message:c.message}):l.warn("WORKER",`Parent mode '${n}' not found for ${e}, falling back to 'code'`,{error:String(c)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),l.debug("SYSTEM",`Loaded override file: ${r} for parent ${n}`)}catch(c){return c instanceof Error?l.warn("WORKER",`Override file '${r}' not found, using parent mode '${n}' only`,{message:c.message}):l.warn("WORKER",`Override file '${r}' not found, using parent mode '${n}' only`,{error:String(c)}),this.activeMode=o,o}if(!i)return l.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${n}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,l.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${n} + ${r})`,void 0,{parent:n,override:r,types:a.observation_types.map(c=>c.id),concepts:a.observation_concepts.map(c=>c.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(n=>n.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(n=>n.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(n=>n.id===e)?.label||e}};function ze(){let t=Q.settings(),e=P.loadFromFile(t),s=w.getInstance().getActiveMode(),n=new Set(s.observation_types.map(o=>o.id)),r=new Set(s.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:n,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var m={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},rs=4,Qe=1;function Ze(t){let e=(t.title?.length||0)+(t.subtitle?.length||0)+(t.narrative?.length||0)+JSON.stringify(t.facts||[]).length;return Math.ceil(e/rs)}function et(t){let e=t.length,s=t.reduce((i,a)=>i+Ze(a),0),n=t.reduce((i,a)=>i+(a.discovery_tokens||0),0),r=n-s,o=n>0?Math.round(r/n*100):0;return{totalObservations:e,totalReadTokens:s,totalDiscoveryTokens:n,savings:r,savingsPercent:o}}function jn(t){return w.getInstance().getWorkEmoji(t)}function ae(t,e){let s=Ze(t),n=t.discovery_tokens||0,r=jn(t.type),o=n>0?`${r} ${n.toLocaleString()}`:"-";return{readTokens:s,discoveryTokens:n,discoveryDisplay:o,workEmoji:r}}function ve(t){return t.showReadTokens||t.showWorkTokens||t.showSavingsAmount||t.showSavingsPercent}var is=W(require("path"),1),Ce=require("fs");var Pn=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],yo=new RegExp(`<(${Pn.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),os=/<system-reminder>[\s\S]*?<\/system-reminder>/g;var Xn=["task-notification"],No=new RegExp(`^\\s*<(${Xn.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Io=256*1024;function tt(t,e,s){let n=Array.from(s.observationTypes),r=n.map(()=>"?").join(","),o=Array.from(s.observationConcepts),i=o.map(()=>"?").join(",");return t.db.prepare(`
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
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND type IN (${r})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,...n,...o,s.totalObservationCount)}function st(t,e,s){return t.db.prepare(`
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
    WHERE (ss.project = ? OR ss.merged_into_project = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,s.sessionCount+Qe)}function as(t,e,s){let n=Array.from(s.observationTypes),r=n.map(()=>"?").join(","),o=Array.from(s.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return t.db.prepare(`
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
    WHERE (o.project IN (${a})
           OR o.merged_into_project IN (${a}))
      AND type IN (${r})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,...n,...o,s.totalObservationCount)}function cs(t,e,s){let n=e.map(()=>"?").join(",");return t.db.prepare(`
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
    WHERE (ss.project IN (${n})
           OR ss.merged_into_project IN (${n}))
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,s.sessionCount+Qe)}function Gn(t){return t.replace(/\//g,"-")}function Hn(t){if(!t.includes('"type":"assistant"'))return null;let e=JSON.parse(t);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let s="";for(let n of e.message.content)n.type==="text"&&(s+=n.text);if(s=s.replace(os,"").trim(),s)return s}return null}function Bn(t){for(let e=t.length-1;e>=0;e--)try{let s=Hn(t[e]);if(s)return s}catch(s){s instanceof Error?l.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},s):l.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(s)});continue}return""}function Wn(t){try{if(!(0,Ce.existsSync)(t))return{userMessage:"",assistantMessage:""};let e=(0,Ce.readFileSync)(t,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim());return{userMessage:"",assistantMessage:Bn(s)}}catch(e){return e instanceof Error?l.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:t},e):l.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:t,error:String(e)}),{userMessage:"",assistantMessage:""}}}function nt(t,e,s,n){if(!e.showLastMessage||t.length===0)return{userMessage:"",assistantMessage:""};let r=t.find(c=>c.memory_session_id!==s);if(!r)return{userMessage:"",assistantMessage:""};let o=r.memory_session_id,i=Gn(n),a=is.default.join(Y,"projects",i,`${o}.jsonl`);return Wn(a)}function ds(t,e){let s=e[0]?.id;return t.map((n,r)=>{let o=r===0?null:e[r+1];return{...n,displayEpoch:o?o.created_at_epoch:n.created_at_epoch,displayTime:o?o.created_at:n.created_at,shouldShowLink:n.id!==s}})}function rt(t,e){let s=[...t.map(n=>({type:"observation",data:n})),...e.map(n=>({type:"summary",data:n}))];return s.sort((n,r)=>{let o=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),s}function ls(t,e){return new Set(t.slice(0,e).map(s=>s.id))}function us(){let t=new Date,e=t.toLocaleDateString("en-CA"),s=t.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),n=t.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${n}`}function _s(t){return[`# [${t}] recent context, ${us()}`,""]}function ms(){return[`Legend: \u{1F3AF}session ${w.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji}${s.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function ps(){return[]}function Es(){return[]}function gs(t,e){let s=[],n=[`${t.totalObservations} obs (${t.totalReadTokens.toLocaleString()}t read)`,`${t.totalDiscoveryTokens.toLocaleString()}t work`];return t.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?n.push(`${t.savingsPercent}% savings`):e.showSavingsAmount&&n.push(`${t.savings.toLocaleString()}t saved`)),s.push(`Stats: ${n.join(" | ")}`),s.push(""),s}function Ts(t){return[`### ${t}`]}function bs(t){return t.toLowerCase().replace(" am","a").replace(" pm","p")}function fs(t,e,s){let n=t.title||"Untitled",r=w.getInstance().getTypeIcon(t.type),o=e?bs(e):'"';return`${t.id} ${o} ${r} ${n}`}function hs(t,e,s,n){let r=[],o=t.title||"Untitled",i=w.getInstance().getTypeIcon(t.type),a=e?bs(e):'"',{readTokens:c,discoveryDisplay:d}=ae(t,n);r.push(`**${t.id}** ${a} ${i} **${o}**`),s&&r.push(s);let u=[];return n.showReadTokens&&u.push(`~${c}t`),n.showWorkTokens&&u.push(d),u.length>0&&r.push(u.join(" ")),r.push(""),r}function Ss(t,e){return[`S${t.id} ${t.request||"Session started"} (${e})`]}function ce(t,e){return e?[`**${t}**: ${e}`,""]:[]}function Os(t){return t.assistantMessage?["","---","","**Previously**","",`A: ${t.assistantMessage}`,""]:[]}function Rs(t,e){return["",`Access ${Math.round(t/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function As(t){return`# [${t}] recent context, ${us()}

No previous sessions found.`}function ys(){let t=new Date,e=t.toLocaleDateString("en-CA"),s=t.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),n=t.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${n}`}function Ns(t){return["",`${m.bright}${m.cyan}[${t}] recent context, ${ys()}${m.reset}`,`${m.gray}${"\u2500".repeat(60)}${m.reset}`,""]}function Is(){let e=w.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji} ${s.id}`).join(" | ");return[`${m.dim}Legend: session-request | ${e}${m.reset}`,""]}function vs(){return[`${m.bright}Column Key${m.reset}`,`${m.dim}  Read: Tokens to read this observation (cost to learn it now)${m.reset}`,`${m.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${m.reset}`,""]}function Cs(){return[`${m.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${m.reset}`,"",`${m.dim}When you need implementation details, rationale, or debugging context:${m.reset}`,`${m.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${m.reset}`,`${m.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${m.reset}`,`${m.dim}  - Trust this index over re-reading code for past decisions and learnings${m.reset}`,""]}function Ms(t,e){let s=[];if(s.push(`${m.bright}${m.cyan}Context Economics${m.reset}`),s.push(`${m.dim}  Loading: ${t.totalObservations} observations (${t.totalReadTokens.toLocaleString()} tokens to read)${m.reset}`),s.push(`${m.dim}  Work investment: ${t.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${m.reset}`),t.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let n="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?n+=`${t.savings.toLocaleString()} tokens (${t.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?n+=`${t.savings.toLocaleString()} tokens`:n+=`${t.savingsPercent}% reduction from reuse`,s.push(`${m.green}${n}${m.reset}`)}return s.push(""),s}function Ds(t){return[`${m.bright}${m.cyan}${t}${m.reset}`,""]}function Ls(t){return[`${m.dim}${t}${m.reset}`]}function ws(t,e,s,n){let r=t.title||"Untitled",o=w.getInstance().getTypeIcon(t.type),{readTokens:i,discoveryTokens:a,workEmoji:c}=ae(t,n),d=s?`${m.dim}${e}${m.reset}`:" ".repeat(e.length),u=n.showReadTokens&&i>0?`${m.dim}(~${i}t)${m.reset}`:"",p=n.showWorkTokens&&a>0?`${m.dim}(${c} ${a.toLocaleString()}t)${m.reset}`:"";return`  ${m.dim}#${t.id}${m.reset}  ${d}  ${o}  ${r} ${u} ${p}`}function Us(t,e,s,n,r){let o=[],i=t.title||"Untitled",a=w.getInstance().getTypeIcon(t.type),{readTokens:c,discoveryTokens:d,workEmoji:u}=ae(t,r),p=s?`${m.dim}${e}${m.reset}`:" ".repeat(e.length),b=r.showReadTokens&&c>0?`${m.dim}(~${c}t)${m.reset}`:"",g=r.showWorkTokens&&d>0?`${m.dim}(${u} ${d.toLocaleString()}t)${m.reset}`:"";return o.push(`  ${m.dim}#${t.id}${m.reset}  ${p}  ${a}  ${m.bright}${i}${m.reset}`),n&&o.push(`    ${m.dim}${n}${m.reset}`),(b||g)&&o.push(`    ${b} ${g}`),o.push(""),o}function xs(t,e){let s=`${t.request||"Session started"} (${e})`;return[`${m.yellow}#S${t.id}${m.reset} ${s}`,""]}function de(t,e,s){return e?[`${s}${t}:${m.reset} ${e}`,""]:[]}function ks(t){return t.assistantMessage?["","---","",`${m.bright}${m.magenta}Previously${m.reset}`,"",`${m.dim}A: ${t.assistantMessage}${m.reset}`,""]:[]}function Fs(t,e){let s=Math.round(t/1e3);return["",`${m.dim}Access ${s}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${m.reset}`]}function $s(t){return`
${m.bright}${m.cyan}[${t}] recent context, ${ys()}${m.reset}
${m.gray}${"\u2500".repeat(60)}${m.reset}

${m.dim}No previous sessions found for this project yet.${m.reset}
`}function js(t,e,s,n){let r=[];return n?r.push(...Ns(t)):r.push(..._s(t)),n?r.push(...Is()):r.push(...ms()),n?r.push(...vs()):r.push(...ps()),n?r.push(...Cs()):r.push(...Es()),ve(s)&&(n?r.push(...Ms(e,s)):r.push(...gs(e,s))),r}function Vn(t){let e=new Map;for(let n of t){let r=n.type==="observation"?n.data.created_at:n.data.displayTime,o=Xe(r);e.has(o)||e.set(o,[]),e.get(o).push(n)}let s=Array.from(e.entries()).sort((n,r)=>{let o=new Date(n[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(s)}function Ps(t,e){return e.fullObservationField==="narrative"?t.narrative:t.facts?he(t.facts).join(`
`):null}function Yn(t,e,s,n){let r=[];r.push(...Ts(t));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,c=Pe(a.displayTime);r.push(...Ss(a,c))}else{let a=i.data,c=Se(a.created_at),u=c!==o?c:"";if(o=c,s.has(a.id)){let b=Ps(a,n);r.push(...hs(a,u,b,n))}else r.push(fs(a,u,n))}return r}function qn(t,e,s,n,r){let o=[];o.push(...Ds(t));let i=null,a="";for(let c of e)if(c.type==="summary"){i=null,a="";let d=c.data,u=Pe(d.displayTime);o.push(...xs(d,u))}else{let d=c.data,u=Rt(d.files_modified,r,d.files_read),p=Se(d.created_at),b=p!==a;a=p;let g=s.has(d.id);if(u!==i&&(o.push(...Ls(u)),i=u),g){let h=Ps(d,n);o.push(...Us(d,p,b,h,n))}else o.push(ws(d,p,b,n))}return o.push(""),o}function Kn(t,e,s,n,r,o){return o?qn(t,e,s,n,r):Yn(t,e,s,n)}function Xs(t,e,s,n,r){let o=[],i=Vn(t);for(let[a,c]of i)o.push(...Kn(a,c,e,s,n,r));return o}function Gs(t,e,s){return!(!t.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||s&&e.created_at_epoch<=s.created_at_epoch)}function Hs(t,e){let s=[];return e?(s.push(...de("Investigated",t.investigated,m.blue)),s.push(...de("Learned",t.learned,m.yellow)),s.push(...de("Completed",t.completed,m.green)),s.push(...de("Next Steps",t.next_steps,m.magenta))):(s.push(...ce("Investigated",t.investigated)),s.push(...ce("Learned",t.learned)),s.push(...ce("Completed",t.completed)),s.push(...ce("Next Steps",t.next_steps))),s}function Bs(t,e){return e?ks(t):Os(t)}function Ws(t,e,s){return!ve(e)||t.totalDiscoveryTokens<=0||t.savings<=0?[]:s?Fs(t.totalDiscoveryTokens,t.totalReadTokens):Rs(t.totalDiscoveryTokens,t.totalReadTokens)}var Jn=Vs.default.join((0,Ys.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function zn(){try{return new Ne}catch(t){if(t instanceof Error&&t.code==="ERR_DLOPEN_FAILED"){try{(0,qs.unlinkSync)(Jn)}catch(e){e instanceof Error?l.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):l.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return l.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw t}}function Qn(t,e){return e?$s(t):As(t)}function Zn(t,e,s,n,r,o,i){let a=[],c=et(e);a.push(...js(t,c,n,i));let d=s.slice(0,n.sessionCount),u=ds(d,s),p=rt(e,u),b=ls(e,n.fullObservationCount);a.push(...Xs(p,b,n,r,i));let g=s[0],h=e[0];Gs(n,g,h)&&a.push(...Hs(g,i));let A=nt(e,n,o,r);return a.push(...Bs(A,i)),a.push(...Ws(c,n,i)),a.join(`
`).trimEnd()}async function ot(t,e=!1){let s=ze(),n=t?.cwd??process.cwd(),r=$e(n),o=t?.projects?.length?t.projects:r.allProjects,i=o[o.length-1]??r.primary;t?.full&&(s.totalObservationCount=999999,s.sessionCount=999999);let a=zn();if(!a)return"";try{let c=o.length>1?as(a,o,s):tt(a,i,s),d=o.length>1?cs(a,o,s):st(a,i,s);return c.length===0&&d.length===0?Qn(i,e):Zn(i,c,d,s,n,t?.session_id,e)}finally{a.close()}}0&&(module.exports={generateContext});
