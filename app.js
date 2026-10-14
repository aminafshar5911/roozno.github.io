/* روزنو | برنامه‌ریز شخصی
 * نسخه‌ی پیش‌فرض: ذخیره روی همین دستگاه با localStorage.
 * برای همگام‌سازی واقعی، مقادیر SUPABASE_URL و SUPABASE_ANON_KEY را در فایل زیر وارد کنید
 * و جدول و سیاست‌های RLS را مطابق README تنظیم کنید.
 */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORAGE_KEY = "roozno-planner-v1";
  const WEEKDAYS = [
    {value:6, label:"شنبه"}, {value:0, label:"یکشنبه"}, {value:1, label:"دوشنبه"},
    {value:2, label:"سه‌شنبه"}, {value:3, label:"چهارشنبه"}, {value:4, label:"پنجشنبه"}, {value:5, label:"جمعه"}
  ];
  const faNumber = value => new Intl.NumberFormat("fa-IR").format(value);
  const persianDate = (date, options = {}) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", options).format(date);
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const dateFromISO = key => { const [y,m,d] = key.split("-").map(Number); return new Date(y,m-1,d,12,0,0); };
  const todayKey = () => isoDate(new Date());
  const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const escapeHTML = str => String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const makeId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const defaultState = () => ({days:{}, weekly:{}, focusSeconds:0, focusByDay:{}, lastWeeklySeeded:{}});
  let state = loadState();
  let selectedDate = todayKey();
  let calendarAnchor = new Date();
  let selectedWeekday = new Date().getDay();
  let supabaseClient = null;
  let currentUser = null;
  let syncTimer = null;
  let timerDuration = 25 * 60;
  let timerRemaining = timerDuration;
  let timerInterval = null;
  let timerRunning = false;
  let timerStartedAt = 0;
  let toastTimer = null;

  function loadState(){
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed && typeof parsed === "object") return {...defaultState(), ...parsed, days:parsed.days||{}, weekly:parsed.weekly||{}, focusByDay:parsed.focusByDay||{}, lastWeeklySeeded:parsed.lastWeeklySeeded||{}};
    } catch (error) { console.warn("Could not load planner data", error); }
    return defaultState();
  }
  function saveLocal(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function dayData(key){
    if (!state.days[key]) state.days[key] = {tasks:[], note:"", finalized:null};
    if (!Array.isArray(state.days[key].tasks)) state.days[key].tasks = [];
    return state.days[key];
  }
  function notify(message){
    const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(()=>toast.classList.remove("show"), 2800);
  }
  function setSyncStatus(message){ $("#syncStatus").textContent = message; }
  function persist({sync=true}={}){
    saveLocal();
    if (sync && supabaseClient && currentUser) {
      setSyncStatus("در حال همگام‌سازی…");
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncToCloud, 500);
    } else if (!currentUser) {
      setSyncStatus("اطلاعات روی همین دستگاه ذخیره می‌شود");
    }
  }
  function getDayStatus(key){
    const data = dayData(key);
    const date = dateFromISO(key);
    if (key > todayKey()) return "future";
    if (key === todayKey()) {
      if (data.tasks.length && data.tasks.every(task=>task.done)) return "complete";
      return "progress";
    }
    if (data.finalized) return data.finalized;
    return data.tasks.length && data.tasks.every(task=>task.done) ? "complete" : "incomplete";
  }
  function finalizeExpiredDays(){
    const nowKey = todayKey();
    Object.keys(state.days).forEach(key=>{
      if (key < nowKey && !state.days[key].finalized) {
        const tasks = state.days[key].tasks || [];
        state.days[key].finalized = tasks.length > 0 && tasks.every(t=>t.done) ? "complete" : "incomplete";
      }
    });
    persist({sync:false});
  }
  function seedWeeklyTasksForDate(key){
    const date = dateFromISO(key), weekday = date.getDay();
    const marker = `${key}:${weekday}`;
    if (state.lastWeeklySeeded[marker]) return false;
    const templates = state.weekly[String(weekday)] || [];
    if (!templates.length) { state.lastWeeklySeeded[marker] = true; return false; }
    const data = dayData(key);
    const existingTemplateIds = new Set(data.tasks.map(t=>t.templateId).filter(Boolean));
    templates.forEach(template=>{
      if (!existingTemplateIds.has(template.id)) data.tasks.push({id:makeId(), title:template.title, time:template.time||"", done:false, templateId:template.id});
    });
    state.lastWeeklySeeded[marker] = true;
    return true;
  }
  function seedTodayAndSelected(){
    const changed = seedWeeklyTasksForDate(todayKey()) | seedWeeklyTasksForDate(selectedDate);
    if (changed) persist({sync:false});
  }
  function formatDateLong(key){
    return persianDate(dateFromISO(key), {weekday:"long", day:"numeric", month:"long", year:"numeric"});
  }
  function formatMonth(date){ return persianDate(date,{month:"long",year:"numeric"}); }
  function startOfPersianMonth(date){
    const cursor = dayStart(date);
    const p = persianParts(cursor);
    for (let i=0;i<33;i++){ const prev = new Date(cursor); prev.setDate(prev.getDate()-1); const pp=persianParts(prev); if(pp.year!==p.year || pp.month!==p.month) break; cursor.setDate(cursor.getDate()-1); }
    return cursor;
  }
  function persianParts(date){
    const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {year:"numeric",month:"numeric",day:"numeric"}).formatToParts(date);
    return {year:Number(parts.find(p=>p.type==="year").value), month:Number(parts.find(p=>p.type==="month").value), day:Number(parts.find(p=>p.type==="day").value)};
  }
  function addDays(date, count){const next=new Date(date);next.setDate(next.getDate()+count);return next;}
  function shiftPersianMonth(date, delta){
    const first = startOfPersianMonth(date);
    return startOfPersianMonth(addDays(first, delta > 0 ? 35 : -1));
  }
  function countMonthDays(anchor){
    const first = startOfPersianMonth(anchor);
    const next = shiftPersianMonth(first, 1);
    return Math.round((next-first)/86400000);
  }
  function updateClock(){
    const now = new Date();
    $("#liveTime").textContent = now.toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    $("#liveDate").textContent = persianDate(now,{day:"numeric",month:"short"});
    $("#todayFullDate").textContent = persianDate(now,{weekday:"long",day:"numeric",month:"long"});
  }
  function renderAll(){
    seedTodayAndSelected();
    updateClock(); renderTasks(); renderCalendar(); renderWeekly(); renderStats(); renderNote(); renderTimer();
  }
  function renderTasks(){
    const data = dayData(selectedDate), list=$("#taskList");
    $("#selectedDateTitle").textContent = selectedDate === todayKey() ? "برنامه‌های امروز" : formatDateLong(selectedDate);
    if (!data.tasks.length){
      list.innerHTML = `<div class="empty-state"><strong>هنوز برنامه‌ای نداری</strong>از کادر پایین، اولین برنامه‌ات رو اضافه کن.</div>`;
    } else {
      list.innerHTML = data.tasks.map(task=>`<div class="task-item ${task.done?"done":""}" data-task-id="${escapeHTML(task.id)}">
        <button class="task-check" type="button" aria-label="${task.done?"علامت‌گذاری به‌عنوان انجام‌نشده":"علامت‌گذاری به‌عنوان انجام‌شده"}">${task.done?"✓":""}</button>
        <div class="task-content"><span class="task-title">${escapeHTML(task.title)}</span>${task.time?`<time class="task-time">${escapeHTML(task.time)}</time>`:""}</div>
        <div class="task-actions">${task.templateId?'<span title="برنامه تکرارشونده" class="recurring-mark">↻</span>':""}<button class="task-delete" type="button" aria-label="حذف برنامه" title="حذف برنامه">×</button></div>
      </div>`).join("");
    }
    const done = data.tasks.filter(t=>t.done).length, total=data.tasks.length, percent=total?Math.round(done/total*100):0;
    $("#dayProgressText").textContent=faNumber(percent)+"٪";
    $("#dayProgressBar").style.width=percent+"%";
    $("#statTasks").textContent=`${faNumber(done)}/${faNumber(total)}`;
    $("#taskProgressBar").style.width=percent+"%";
    const status=getDayStatus(selectedDate);
    const pill=$("#dayStatus");
    if(selectedDate===todayKey()){pill.textContent=total>0&&done===total?"همه کارها انجام شد":"در حال انجام";pill.className="status-pill "+(total>0&&done===total?"status-complete":"status-progress");}
    else if(status==="complete"){pill.textContent="روز کامل";pill.className="status-pill status-complete";}
    else if(status==="incomplete"){pill.textContent="روز ناقص";pill.className="status-pill status-incomplete";}
    else {pill.textContent="روز آینده";pill.className="status-pill status-progress";}
  }
  function renderCalendar(){
    const first=startOfPersianMonth(calendarAnchor);
    const firstOffset=(first.getDay()+1)%7; // Saturday-first
    const gridStart=addDays(first,-firstOffset);
    $("#calendarMonthTitle").textContent=formatMonth(first);
    const today=todayKey(), cells=[];
    for(let i=0;i<42;i++){
      const date=addDays(gridStart,i), key=isoDate(date), parts=persianParts(date), currentMonth=parts.year===persianParts(first).year&&parts.month===persianParts(first).month;
      const status=getDayStatus(key);
      const classes=["calendar-day"];
      if(!currentMonth) classes.push("other-month");
      if(key===today) classes.push("today");
      if(key===selectedDate) classes.push("selected");
      if(status==="complete") classes.push("complete");
      if(status==="incomplete") classes.push("incomplete");
      if(status==="future") classes.push("future");
      const mark=status==="complete"?"✓":status==="incomplete"?"×":(key===today?"•":"");
      cells.push(`<button type="button" class="${classes.join(" ")}" data-date="${key}" aria-label="${escapeHTML(formatDateLong(key))}، ${status==="complete"?"کامل":status==="incomplete"?"ناقص":status==="future"?"آینده":"در جریان"}"><span class="day-number">${faNumber(parts.day)}</span><span class="day-mark">${mark}</span></button>`);
    }
    $("#calendarGrid").innerHTML=cells.join("");
    const monthEnd=addDays(shiftPersianMonth(first,1),-1), todayDate=dayStart(new Date());
    const elapsedEnd=todayDate<first?addDays(first,-1):(todayDate>monthEnd?monthEnd:todayDate);
    let daysElapsed=0, complete=0;
    if(elapsedEnd>=first){
      for(let d=new Date(first);d<=elapsedEnd;d=addDays(d,1)){ const key=isoDate(d); daysElapsed++; if(getDayStatus(key)==="complete") complete++; }
    }
    const percent=daysElapsed?Math.round(complete/daysElapsed*100):0;
    $("#monthPercent").textContent=faNumber(percent)+"٪";
    $("#monthDonut").style.background=`conic-gradient(#111 ${percent}%, #ecece8 ${percent}% 100%)`;
    $("#statCompleteDays").textContent=faNumber(complete);
    $("#statMonthName").textContent=formatMonth(first);
    $("#statCompleteRatio").textContent=faNumber(percent)+"٪";
    $("#monthCounts").textContent=`${faNumber(complete)} روز کامل از ${faNumber(daysElapsed)} روز گذشته`;
    $("#monthInsightTitle").textContent=percent>=80?"عالی پیش می‌ری!":percent>=50?"ادامه بده، نزدیک‌تری":"قدم‌به‌قدم جلو برو";
    $("#monthInsightText").textContent=daysElapsed?`تا اینجای ماه، ${faNumber(percent)}٪ از روزها رو کامل گذروندی.`:"با پایان اولین روز، نمودار پیشرفتت اینجا نمایش داده می‌شه.";
  }
  function renderStats(){
    const today=dayData(todayKey());
    const seconds=state.focusByDay[todayKey()]||0;
    $("#statFocus").textContent=secondsToClock(seconds);
  }
  function renderNote(){
    const note=dayData(selectedDate).note||"";
    $("#dailyNote").value=note;
    $("#noteCharCount").textContent=`${faNumber(note.length)} / ۵۰۰۰`;
    $("#noteSaveState").textContent="ذخیره خودکار فعال است";
  }
  function renderWeekly(){
    $$("#weekdayTabs button").forEach(btn=>btn.classList.toggle("active",Number(btn.dataset.weekday)===selectedWeekday));
    const templates=state.weekly[String(selectedWeekday)]||[];
    $("#weeklyList").innerHTML=templates.length?templates.map(item=>`<div class="weekly-item" data-weekly-id="${escapeHTML(item.id)}"><span class="weekly-item-title">${escapeHTML(item.title)}</span>${item.time?`<time>${escapeHTML(item.time)}</time>`:""}<button type="button" aria-label="حذف برنامه هفتگی" title="حذف">×</button></div>`).join(""):`<div class="empty-state">برای ${WEEKDAYS.find(d=>d.value===selectedWeekday)?.label||"این روز"} هنوز برنامه‌ی تکرارشونده‌ای ثبت نشده.</div>`;
  }
  function secondsToClock(seconds){
    const minutes=Math.floor(seconds/60), secs=seconds%60;
    return `${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`.replace(/[0-9]/g,d=>"۰۱۲۳۴۵۶۷۸۹"[d]);
  }
  function renderTimer(){
    $("#timerDisplay").textContent=secondsToClock(timerRemaining);
    $("#timerMode").textContent=timerRunning?"در حال تمرکز":"زمان مطالعه";
    $("#timerSubtext").textContent=timerRunning?"آروم و پیوسته ادامه بده":timerRemaining===0?"جلسه تموم شد!":"آماده‌ای؟";
    $("#timerStart").innerHTML=timerRunning?"توقف موقت <span>Ⅱ</span>":(timerRemaining<timerDuration?"ادامه مطالعه <span>▶</span>":"شروع مطالعه <span>▶</span>");
    const elapsed=timerDuration-timerRemaining, percent=timerDuration?Math.min(100,elapsed/timerDuration*100):0;
    $("#timerRing").style.background=`conic-gradient(#fff ${percent}%, #333 ${percent}% 100%)`;
    $$("[data-minutes]").forEach(btn=>btn.classList.toggle("active",Number(btn.dataset.minutes)*60===timerDuration));
  }
  function addTask(title,time="",templateId=null){
    const clean=title.trim(); if(!clean)return;
    dayData(selectedDate).tasks.push({id:makeId(),title:clean,time,done:false,...(templateId?{templateId}:{})});
    persist(); renderTasks(); renderCalendar(); renderStats(); $("#newTaskTitle").value="";$("#newTaskTime").value="";
  }
  $("#addTaskForm").addEventListener("submit",event=>{
    event.preventDefault();const title=$("#newTaskTitle").value;
    if(!title.trim()){notify("اول عنوان برنامه رو بنویس.");return;}
    addTask(title,$("#newTaskTime").value);notify("برنامه اضافه شد.");
  });
  $("#taskList").addEventListener("click",event=>{
    const row=event.target.closest("[data-task-id]");if(!row)return;
    const data=dayData(selectedDate), task=data.tasks.find(t=>t.id===row.dataset.taskId);if(!task)return;
    if(event.target.closest(".task-check")){
      task.done=!task.done;
      if(selectedDate<todayKey() && !data.finalized) data.finalized=data.tasks.length&&data.tasks.every(t=>t.done)?"complete":"incomplete";
      persist();renderTasks();renderCalendar();renderStats();
      if(task.done && data.tasks.length && data.tasks.every(t=>t.done)) notify("آفرین! همه برنامه‌های این روز انجام شد.");
    }else if(event.target.closest(".task-delete")){
      data.tasks=data.tasks.filter(t=>t.id!==task.id);persist();renderTasks();renderCalendar();renderStats();notify("برنامه حذف شد.");
    }
  });
  $("#goTodayButton").addEventListener("click",()=>{selectedDate=todayKey();calendarAnchor=new Date();seedTodayAndSelected();renderAll();});
  $("#calendarGrid").addEventListener("click",event=>{
    const btn=event.target.closest("[data-date]");if(!btn)return;
    selectedDate=btn.dataset.date;const date=dateFromISO(selectedDate);
    if(persianParts(date).year!==persianParts(calendarAnchor).year||persianParts(date).month!==persianParts(calendarAnchor).month)calendarAnchor=date;
    seedTodayAndSelected();renderAll();
  });
  $("#prevMonth").addEventListener("click",()=>{calendarAnchor=shiftPersianMonth(calendarAnchor,-1);renderCalendar();});
  $("#nextMonth").addEventListener("click",()=>{calendarAnchor=shiftPersianMonth(calendarAnchor,1);renderCalendar();});
  $("#weekdayTabs").addEventListener("click",event=>{
    const btn=event.target.closest("[data-weekday]");if(!btn)return;selectedWeekday=Number(btn.dataset.weekday);renderWeekly();
  });
  $("#weeklyForm").addEventListener("submit",event=>{
    event.preventDefault();const title=$("#weeklyTitle").value.trim();if(!title)return;
    const key=String(selectedWeekday);state.weekly[key] ||= [];
    state.weekly[key].push({id:makeId(),title,time:$("#weeklyTime").value||""});
    $("#weeklyTitle").value="";$("#weeklyTime").value="";persist();renderWeekly();
    // If the selected date is this weekday and its seed marker is still unset, offer immediate inclusion.
    if(dateFromISO(selectedDate).getDay()===selectedWeekday && !state.lastWeeklySeeded[`${selectedDate}:${selectedWeekday}`]){
      seedWeeklyTasksForDate(selectedDate);persist();renderTasks();renderCalendar();
    }
    notify("برنامه هفتگی ذخیره شد.");
  });
  $("#weeklyList").addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button)return;const row=button.closest("[data-weekly-id]");if(!row)return;
    state.weekly[String(selectedWeekday)]=(state.weekly[String(selectedWeekday)]||[]).filter(t=>t.id!==row.dataset.weeklyId);
    // Remove not-yet-completed instances created from this template; keep past task history.
    Object.values(state.days).forEach(day=>{day.tasks=(day.tasks||[]).filter(t=>t.templateId!==row.dataset.weeklyId || t.done);});
    persist();renderWeekly();renderTasks();renderCalendar();notify("برنامه تکرارشونده حذف شد.");
  });
  let noteSaveTimer=null;
  $("#dailyNote").addEventListener("input",()=>{
    const note=$("#dailyNote").value;$("#noteCharCount").textContent=`${faNumber(note.length)} / ۵۰۰۰`;
    $("#noteSaveState").textContent="در حال ذخیره…";
    clearTimeout(noteSaveTimer);noteSaveTimer=setTimeout(()=>{dayData(selectedDate).note=note;persist();$("#noteSaveState").textContent="ذخیره شد";},350);
  });
  $$("[data-minutes]").forEach(btn=>btn.addEventListener("click",()=>{
    if(timerRunning){notify("اول تایمر رو متوقف کن.");return;}
    timerDuration=Number(btn.dataset.minutes)*60;timerRemaining=timerDuration;renderTimer();
  }));
  $("#timerStart").addEventListener("click",()=>{
    if(timerRunning){pauseTimer();return;}
    if(timerRemaining<=0){timerRemaining=timerDuration;}
    timerRunning=true;timerStartedAt=Date.now();timerInterval=setInterval(tickTimer,250);renderTimer();
  });
  $("#timerReset").addEventListener("click",()=>{
    pauseTimer();timerRemaining=timerDuration;renderTimer();notify("تایمر از نو آماده شد.");
  });
  function pauseTimer(){
    if(timerRunning){timerRunning=false;clearInterval(timerInterval);timerInterval=null;renderTimer();}
  }
  function tickTimer(){
    const elapsed=Math.floor((Date.now()-timerStartedAt)/1000);
    const expected=Math.max(0,timerRemainingAtStart-elapsed);
    const delta=Math.max(0,lastTimerValue-expected);
    if(delta>0){const key=todayKey();state.focusByDay[key]=(state.focusByDay[key]||0)+delta;state.focusSeconds=(state.focusSeconds||0)+delta;lastTimerValue=expected;persist({sync:false});}
    timerRemaining=expected;
    if(timerRemaining<=0){pauseTimer();timerRemaining=0;renderTimer();renderStats();notify("آفرین! زمان مطالعه‌ات تموم شد.");}
    else {renderTimer();renderStats();}
  }
  let timerRemainingAtStart=timerRemaining,lastTimerValue=timerRemaining;
  const originalTimerStart=$("#timerStart");
  originalTimerStart.addEventListener("click",()=>{if(timerRunning){timerRemainingAtStart=timerRemaining;lastTimerValue=timerRemaining;}},{capture:true});

  // Optional Supabase sync. Set credentials in this file; OAuth redirect must be allow-listed in Supabase.
  const SUPABASE_URL = "https://bqzrvmnzgytjpdlxbtup.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_hKjX142K3-bMnD8qnRlXKw_BCzYkU3T";
  async function setupSupabase(){
    const configured=!SUPABASE_URL.includes("YOUR_PROJECT")&&!SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
    $("#loginButton").addEventListener("click", loginWithGoogle);
    if(!configured){
      setSyncStatus("تنظیمات Supabase در app.js کامل نیست");
      return;
    }
    if(!window.supabase){
      setSyncStatus("کتابخانه Supabase بارگذاری نشد؛ اتصال اینترنت یا CDN را بررسی کن");
      return;
    }
    supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
    const {data:{session}}=await supabaseClient.auth.getSession();
    if(session){currentUser=session.user;showUser(currentUser);await syncFromCloud();}
    supabaseClient.auth.onAuthStateChange(async(_event,session)=>{
      currentUser=session?.user||null;
      if(currentUser){showUser(currentUser);await syncFromCloud();}
      else{showLoggedOut();}
    });
    $("#logoutButton").addEventListener("click",async()=>{await supabaseClient.auth.signOut();});
    if(!currentUser) setSyncStatus("برای همگام‌سازی، با گوگل وارد شو");
  }
  async function loginWithGoogle(){
    if(!supabaseClient){notify("ورود با گوگل هنوز راه‌اندازی نشده؛ ابتدا تنظیمات Supabase را در app.js وارد کن.");return;}
    const {error}=await supabaseClient.auth.signInWithOAuth({provider:"google",options:{redirectTo:window.location.origin+window.location.pathname}});
    if(error)notify("ورود با گوگل انجام نشد: "+error.message);
  }
  function showUser(user){
    $("#loginButton").classList.add("hidden");$("#userChip").classList.remove("hidden");$("#userEmail").textContent=user.email||"حساب گوگل";
    setSyncStatus("حساب متصل است؛ آماده‌ی همگام‌سازی");
  }
  function showLoggedOut(){
    $("#loginButton").classList.remove("hidden");$("#userChip").classList.add("hidden");setSyncStatus("اطلاعات روی همین دستگاه ذخیره می‌شود");
  }
  async function syncToCloud(){
    if(!supabaseClient||!currentUser)return;
    try{
      const {error}=await supabaseClient.from("planner_data").upsert({user_id:currentUser.id,payload:state,updated_at:new Date().toISOString()},{onConflict:"user_id"});
      if(error)throw error;setSyncStatus("همگام‌سازی شد · "+new Date().toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"}));
    }catch(error){console.error(error);setSyncStatus("خطا در همگام‌سازی؛ تنظیمات Supabase را بررسی کن");}
  }
  async function syncFromCloud(){
    if(!supabaseClient||!currentUser)return;
    try{
      setSyncStatus("دریافت اطلاعات آنلاین…");
      const {data,error}=await supabaseClient.from("planner_data").select("payload").eq("user_id",currentUser.id).maybeSingle();
      if(error)throw error;
      if(data?.payload){
        const cloud = {...defaultState(), ...data.payload};
        const localRaw = localStorage.getItem(STORAGE_KEY);
        const localHasData = !!localRaw && (
          Object.keys(state.days || {}).length > 0 ||
          Object.keys(state.weekly || {}).length > 0 ||
          Object.keys(state.focusByDay || {}).length > 0
        );
        if (localHasData) {
          const merged = {...cloud, ...state, days:{...cloud.days}, weekly:{...cloud.weekly},
            focusByDay:{...cloud.focusByDay}, lastWeeklySeeded:{...cloud.lastWeeklySeeded}};
          const allDayKeys = new Set([...Object.keys(cloud.days||{}), ...Object.keys(state.days||{})]);
          for (const key of allDayKeys) {
            const c = cloud.days?.[key] || {tasks:[], note:"", finalized:null};
            const l = state.days?.[key] || {tasks:[], note:"", finalized:null};
            const taskMap = new Map();
            [...(c.tasks||[]), ...(l.tasks||[])].forEach(task => taskMap.set(task.id, task));
            merged.days[key] = {...c, ...l, tasks:[...taskMap.values()],
              note:(l.note || c.note || ""), finalized:l.finalized || c.finalized || null};
          }
          for (const key of new Set([...Object.keys(cloud.weekly||{}), ...Object.keys(state.weekly||{})])) {
            const templates = new Map();
            [...(cloud.weekly?.[key]||[]), ...(state.weekly?.[key]||[])].forEach(item => templates.set(item.id, item));
            merged.weekly[key] = [...templates.values()];
          }
          merged.focusByDay = {...cloud.focusByDay, ...state.focusByDay};
          merged.focusSeconds = Math.max(Number(cloud.focusSeconds||0), Number(state.focusSeconds||0));
          merged.lastWeeklySeeded = {...cloud.lastWeeklySeeded, ...state.lastWeeklySeeded};
          state = merged;
          await syncToCloud();
        } else {
          state = cloud;
        }
        saveLocal();
        renderAll();
      } else {
        await syncToCloud();
      }
      setSyncStatus("همگام‌سازی فعال است");
    }catch(error){console.error(error);setSyncStatus("خطا در اتصال؛ جدول و دسترسی‌های Supabase را بررسی کن");}
  }

  // Finalize yesterday when a new date begins; completed status is retained for history.
  let lastSeenToday=todayKey();
  setInterval(()=>{
    updateClock();
    const key=todayKey();
    if(key!==lastSeenToday){
      const old=dayData(lastSeenToday);old.finalized=old.tasks.length>0&&old.tasks.every(t=>t.done)?"complete":"incomplete";
      lastSeenToday=key;selectedDate=key;calendarAnchor=new Date();seedTodayAndSelected();persist();renderAll();
      notify("روز جدید شروع شد؛ برنامه‌هات رو بچین.");
    }
  },1000);
  finalizeExpiredDays();
  // Initialize timer bookkeeping and UI.
  renderAll();
  setupSupabase();
})();