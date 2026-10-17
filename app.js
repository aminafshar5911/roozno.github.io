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

  const defaultState = () => ({days:{}, weekly:{}, focusSeconds:0, focusByDay:{}, lastWeeklySeeded:{}, habits:[], habitLogs:{}, goals:[], notes:[], deletedHabitIds:[], deletedGoalIds:[], deletedNoteIds:[], preferences:{theme:"light",accent:"#171717"}, game:{bonusXP:0,claimedMissions:[]}});
  let state = loadState();
  let selectedDate = todayKey();
  let editingTaskId = null;
  let lastProfileTrigger = null;
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
      if (parsed && typeof parsed === "object") return {...defaultState(), ...parsed, days:parsed.days||{}, weekly:parsed.weekly||{}, focusByDay:parsed.focusByDay||{}, lastWeeklySeeded:parsed.lastWeeklySeeded||{}, habits:Array.isArray(parsed.habits)?parsed.habits:[], habitLogs:parsed.habitLogs||{}, goals:Array.isArray(parsed.goals)?parsed.goals:[], notes:Array.isArray(parsed.notes)?parsed.notes:[], deletedHabitIds:Array.isArray(parsed.deletedHabitIds)?parsed.deletedHabitIds:[], deletedGoalIds:Array.isArray(parsed.deletedGoalIds)?parsed.deletedGoalIds:[], deletedNoteIds:Array.isArray(parsed.deletedNoteIds)?parsed.deletedNoteIds:[], preferences:{theme:"light",accent:"#171717",...(parsed.preferences||{})}, game:{bonusXP:0,claimedMissions:[],...(parsed.game||{})}};
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
  function setSyncStatus(message){
    $("#syncStatus").textContent = message;
    const modalStatus = $("#profileSyncStatus");
    if (modalStatus) modalStatus.textContent = message;
  }
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
    // Never create new task instances retroactively when browsing a past date.
    const changed = seedWeeklyTasksForDate(todayKey()) | (selectedDate >= todayKey() ? seedWeeklyTasksForDate(selectedDate) : false);
    if (changed) persist({sync:false});
  }
  function selectedDateIsPast(){ return selectedDate < todayKey(); }
  function selectedDateIsFuture(){ return selectedDate > todayKey(); }
  function selectedDateIsLocked(){ return selectedDateIsPast(); }
  function updateTaskEditingState(){
    // Only past dates are read-only. Future dates must remain editable for planning.
    const pastLocked = selectedDateIsPast();
    const form = $("#addTaskForm");
    if(form){
      form.querySelectorAll("input,button").forEach(el=>{ el.disabled = pastLocked; });
      form.setAttribute("aria-disabled", String(pastLocked));
      form.dataset.dateMode = pastLocked ? "past-locked" : (selectedDateIsFuture() ? "future-planning" : "today-editable");
    }
    const note = $("#dailyNote");
    if(note){ note.readOnly = false; }
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
    updateClock(); renderTasks(); renderCalendar(); renderWeekly(); renderStats(); renderNote(); renderTimer(); renderToolkit(); applyPreferences();
  }
  function renderTasks(){
    const data = dayData(selectedDate), list=$("#taskList");
    const pastLocked = selectedDateIsPast();
    const future = selectedDateIsFuture();
    updateTaskEditingState();
    $("#selectedDateTitle").textContent = selectedDate === todayKey() ? "برنامه‌های امروز" : formatDateLong(selectedDate);
    let lockHint = document.getElementById("taskLockHint");
    if(!lockHint){ lockHint=document.createElement("p"); lockHint.id="taskLockHint"; lockHint.className="task-lock-hint"; $("#selectedDateTitle").parentElement.appendChild(lockHint); }
    lockHint.textContent = pastLocked ? "🔒 روز گذشته؛ فقط برای مشاهده است و هیچ تغییری در برنامه‌ها ممکن نیست." : future ? "🗓️ روز آینده؛ می‌توانی برنامه‌ها را اضافه، ویرایش یا حذف کنی؛ تیک انجام فقط در همان روز فعال می‌شود." : "";
    lockHint.hidden = !(pastLocked || future);
    const filter = document.getElementById("taskFilter")?.value || "all";
    const visibleTasks = data.tasks.filter(task => filter === "open" ? !task.done : filter === "done" ? task.done : filter === "timed" ? !!task.time : true);
    if (!data.tasks.length){
      list.innerHTML = `<div class="empty-state"><strong>هنوز برنامه‌ای نداری</strong>از کادر پایین، اولین برنامه‌ات رو اضافه کن.</div>`;
    } else if (!visibleTasks.length) {
      list.innerHTML = `<div class="empty-state">کاری با این فیلتر پیدا نشد.</div>`;
    } else {
      list.innerHTML = visibleTasks.map(task=>{
        if (editingTaskId === task.id && !pastLocked) {
          return `<div class="task-item task-item-editing" data-task-id="${escapeHTML(task.id)}">
            <form class="task-edit-form" data-task-edit-form>
              <label class="sr-only" for="taskEditTitle">عنوان برنامه</label>
              <input id="taskEditTitle" class="task-edit-title" name="title" type="text" maxlength="100" required value="${escapeHTML(task.title)}" aria-label="عنوان برنامه">
              <label class="sr-only" for="taskEditTime">ساعت برنامه</label>
              <input id="taskEditTime" class="task-edit-time" name="time" type="time" value="${escapeHTML(task.time||"")}" aria-label="ساعت برنامه">
              <div class="task-edit-buttons"><button class="button button-dark task-edit-save" type="submit">ذخیره</button><button class="button button-light task-edit-cancel" type="button">لغو</button></div>
            </form>
          </div>`;
        }
        return `<div class="task-item ${task.done?"done":""}" data-task-id="${escapeHTML(task.id)}">
          <button class="task-check" type="button" ${(pastLocked||future)?"disabled title=\"تیک انجام کار فقط در روز جاری فعال است\"":""} aria-label="${task.done?"علامت‌گذاری به‌عنوان انجام‌نشده":"علامت‌گذاری به‌عنوان انجام‌شده"}">${task.done?"✓":""}</button>
          <div class="task-content"><span class="task-title">${escapeHTML(task.title)}</span>${task.time?`<time class="task-time">${escapeHTML(task.time)}</time>`:""}</div>
          <div class="task-actions">${task.templateId?'<span title="برنامه تکرارشونده" class="recurring-mark">↻</span>':""}<button class="task-edit" type="button" ${pastLocked?"disabled title=\"کارهای روزهای گذشته قابل تغییر نیستند\"":""} aria-label="ویرایش برنامه" title="ویرایش برنامه">✎</button><button class="task-delete" type="button" ${pastLocked?"disabled title=\"کارهای روزهای گذشته قابل تغییر نیستند\"":""} aria-label="حذف برنامه" title="حذف برنامه">×</button></div>
        </div>`;
      }).join("");
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
    if(selectedDateIsPast()){notify("روزهای گذشته فقط برای مشاهده هستند؛ امکان تغییر برنامه‌ها وجود ندارد.");return;}
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
    const action = event.target.closest(".task-check, .task-edit, .task-delete, .task-edit-cancel");
    if(!action)return;
    if (action.classList.contains("task-edit-cancel")) { editingTaskId=null; renderTasks(); return; }
    if(selectedDateIsPast()){
      notify("روزهای گذشته فقط برای مشاهده هستند و قابل تغییر نیستند.");
      return;
    }
    if(selectedDateIsFuture() && action.classList.contains("task-check")){
      notify("تیک انجام کار فقط در روز جاری فعال است.");
      return;
    }
    const data=dayData(selectedDate), task=data.tasks.find(t=>t.id===row.dataset.taskId);if(!task)return;
    if(action.classList.contains("task-edit")){
      editingTaskId=task.id;renderTasks();
      requestAnimationFrame(()=>$("#taskEditTitle")?.focus());
    }else if(action.classList.contains("task-check")){
      // Defensive guard: task completion can only be changed on today's date.
      if(selectedDate!==todayKey()){notify("تیک انجام کار فقط در روز جاری فعال است.");return;}
      task.done=!task.done;
      if(selectedDate<todayKey() && !data.finalized) data.finalized=data.tasks.length&&data.tasks.every(t=>t.done)?"complete":"incomplete";
      persist();renderTasks();renderCalendar();renderStats();renderToolkit();
      if(task.done && data.tasks.length && data.tasks.every(t=>t.done)) notify("آفرین! همه برنامه‌های این روز انجام شد.");
    }else if(action.classList.contains("task-delete")){
      data.tasks=data.tasks.filter(t=>t.id!==task.id);editingTaskId=null;persist();renderTasks();renderCalendar();renderStats();renderToolkit();notify("برنامه حذف شد.");
    }
  });
  $("#taskList").addEventListener("submit",event=>{
    const form=event.target.closest(".task-edit-form");if(!form)return;
    event.preventDefault();
    if(selectedDateIsPast()){editingTaskId=null;renderTasks();notify("روزهای گذشته فقط برای مشاهده هستند و قابل تغییر نیستند.");return;}
    const row=form.closest("[data-task-id]"), task=dayData(selectedDate).tasks.find(t=>t.id===row?.dataset.taskId);
    if(!task)return;
    const title=form.elements.title.value.trim(), time=form.elements.time.value||"";
    if(!title){notify("عنوان برنامه نمی‌تواند خالی باشد.");return;}
    task.title=title;task.time=time;editingTaskId=null;persist();renderTasks();renderCalendar();notify("برنامه ویرایش شد.");
  });
  $("#goTodayButton").addEventListener("click",()=>{editingTaskId=null;selectedDate=todayKey();calendarAnchor=new Date();seedTodayAndSelected();renderAll();});
  $("#calendarGrid").addEventListener("click",event=>{
    const btn=event.target.closest("[data-date]");if(!btn)return;
    editingTaskId=null;selectedDate=btn.dataset.date;const date=dateFromISO(selectedDate);
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
    Object.entries(state.days).forEach(([dateKey,day])=>{
      // Past task history is immutable, even when a recurring template is removed.
      if(dateKey < todayKey()) return;
      day.tasks=(day.tasks||[]).filter(t=>t.templateId!==row.dataset.weeklyId || t.done);
    });
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
    if(delta>0){const key=todayKey();state.focusByDay[key]=(state.focusByDay[key]||0)+delta;state.focusSeconds=(state.focusSeconds||0)+delta;lastTimerValue=expected;persist({sync:false});renderToolkit();}
    timerRemaining=expected;
    if(timerRemaining<=0){pauseTimer();timerRemaining=0;renderTimer();renderStats();notify("آفرین! زمان مطالعه‌ات تموم شد.");}
    else {renderTimer();renderStats();}
  }
  let timerRemainingAtStart=timerRemaining,lastTimerValue=timerRemaining;
  const originalTimerStart=$("#timerStart");
  originalTimerStart.addEventListener("click",()=>{if(timerRunning){timerRemainingAtStart=timerRemaining;lastTimerValue=timerRemaining;}},{capture:true});

  // Advanced tools: streaks, habits, goals, searchable notes, theme and portable backups.
  function isCompletedDay(key){const tasks=state.days?.[key]?.tasks||[];return tasks.length>0&&tasks.every(task=>task.done===true);}
  function getStreakStats(){
    const today=todayKey(); let current=0, best=0, run=0;
    const keys=Object.keys(state.days||{}).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)&&k<=today).sort();
    let previous=null;
    for(const key of keys){const date=dateFromISO(key); if(previous && Math.round((date-previous)/86400000)!==1)run=0; if(isCompletedDay(key)){run++;best=Math.max(best,run);}else run=0;previous=date;}
    let cursor=dateFromISO(today);
    if(!isCompletedDay(today)) cursor=addDays(cursor,-1);
    while(isCompletedDay(isoDate(cursor))){current++;cursor=addDays(cursor,-1);}
    return {current,best};
  }
  const GAME_LEVELS=[{xp:0,name:"تازه‌کار"},{xp:500,name:"پیش‌رونده"},{xp:1000,name:"حرفه‌ای"},{xp:2500,name:"استاد برنامه‌ریزی"},{xp:5000,name:"افسانه‌ای"}];
  const GAME_UNLOCKS=[
    {xp:500,title:"نشان‌های ویژه",desc:"نشان‌های افتخار بر اساس رکوردها",icon:"🏅"},
    {xp:1000,title:"آمار پیشرفته",desc:"نمایش گزارش‌ها و رکوردهای پیشرفت",icon:"📊"},
    {xp:2500,title:"تم ویژه",desc:"یک ظاهر تازه برای روزنو",icon:"🎨"},
    {xp:5000,title:"حالت افسانه‌ای",desc:"نشان و عنوان اختصاصی سطح آخر",icon:"👑"}
  ];
  function getPoints(){
    let taskPoints=0, perfectDays=0, habitPoints=0;
    Object.entries(state.days||{}).forEach(([key,data])=>{const tasks=data.tasks||[];taskPoints+=tasks.filter(t=>t.done).length*10;if(tasks.length&&tasks.every(t=>t.done))perfectDays++;});
    Object.values(state.habitLogs||{}).forEach(ids=>habitPoints+=(Array.isArray(ids)?ids.length:0)*5);
    const focusPoints=Object.values(state.focusByDay||{}).reduce((sum,seconds)=>sum+Math.floor((Number(seconds)||0)/300),0);
    return taskPoints+perfectDays*25+habitPoints+focusPoints+Math.max(0,Number(state.game?.bonusXP)||0);
  }
  function dailyMissionData(){
    const key=todayKey(), data=state.days?.[key]||{tasks:[]}, tasks=data.tasks||[], done=tasks.filter(t=>t.done).length, habits=state.habitLogs?.[key]||[], focus=Number(state.focusByDay?.[key])||0;
    return [
      {id:"tasks3",title:"انجام ۳ کار امروز",reward:20,ok:done>=3,progress:`${Math.min(done,3)} از ۳`},
      {id:"habit1",title:"ثبت یک عادت امروز",reward:10,ok:habits.length>=1,progress:habits.length?"انجام شد":"۰ از ۱"},
      {id:"focus25",title:"۲۵ دقیقه تمرکز",reward:25,ok:focus>=1500,progress:`${Math.min(25,Math.floor(focus/60))} از ۲۵ دقیقه`},
      {id:"perfect",title:"تکمیل همه کارهای امروز",reward:30,ok:tasks.length>0&&tasks.every(t=>t.done),progress:tasks.length?`${done} از ${tasks.length}`:"اول کار اضافه کن"}
    ];
  }
  function claimCompletedMissions(){
    if(!state.game)state.game={bonusXP:0,claimedMissions:[]};
    if(!Array.isArray(state.game.claimedMissions))state.game.claimedMissions=[];
    let gained=0;
    dailyMissionData().forEach(m=>{const claimKey=`${todayKey()}:${m.id}`;if(m.ok&&!state.game.claimedMissions.includes(claimKey)){state.game.claimedMissions.push(claimKey);state.game.bonusXP=(Number(state.game.bonusXP)||0)+m.reward;gained+=m.reward;}});
    if(gained){persist();notify(`مأموریت انجام شد! ${faNumber(gained)} XP جایزه گرفتی.`);}
  }
  function renderGame(points){
    const levelIndex=GAME_LEVELS.reduce((idx,l,i)=>points>=l.xp?i:idx,0), level=GAME_LEVELS[levelIndex], next=GAME_LEVELS[levelIndex+1];
    $("#playerLevel").textContent=`سطح ${faNumber(levelIndex+1)} · ${level.name}`;$("#xpTotal").textContent=`${faNumber(points)} XP`;
    const pct=next?Math.max(0,Math.min(100,((points-level.xp)/(next.xp-level.xp))*100)):100;
    $("#xpProgress").style.width=`${pct}%`;
    $("#xpNextText").textContent=next?`${faNumber(next.xp-points)} XP تا سطح بعدی (${next.name})`:"به بالاترین سطح رسیدی؛ افسانه‌ای هستی!";
    $("#dailyMissions").innerHTML=dailyMissionData().map(m=>{const claimed=(state.game?.claimedMissions||[]).includes(`${todayKey()}:${m.id}`);return `<div class="game-row ${m.ok||claimed?"mission-done":""}"><span class="game-icon">${claimed?"✓":"🎯"}</span><div class="game-row-text"><strong>${escapeHTML(m.title)}</strong><small>${escapeHTML(m.progress)} · جایزه ${faNumber(m.reward)} XP</small></div><b>${claimed?"گرفته شد":m.ok?"تکمیل شد":"در انتظار"}</b></div>`;}).join("");
    $("#unlockableFeatures").innerHTML=GAME_UNLOCKS.map(u=>{const unlocked=points>=u.xp;return `<div class="game-row ${unlocked?"mission-done":"locked-feature"}"><span class="game-icon">${unlocked?u.icon:"🔒"}</span><div class="game-row-text"><strong>${escapeHTML(u.title)}</strong><small>${escapeHTML(u.desc)}</small></div><b>${unlocked?"باز شد":`${faNumber(u.xp)} XP`}</b></div>`;}).join("");
  }
  function renderToolkit(){
    if(!document.getElementById("currentStreak"))return;
    claimCompletedMissions();
    const streak=getStreakStats(), points=getPoints();
    renderGame(points);
    $("#currentStreak").textContent=faNumber(streak.current);$("#bestStreak").textContent=faNumber(streak.best);$("#totalPoints").textContent=faNumber(points);
    $("#streakMessage").textContent=streak.current?`عالیه! ${faNumber(streak.current)} روز پشت سر هم روزت رو کامل کردی.`:"اولین قدم رو بردار؛ با تکمیل همه کارهای یک روز، استریک شروع می‌شه.";
    const days=[];for(let i=6;i>=0;i--){const d=addDays(dateFromISO(todayKey()),-i),key=isoDate(d);days.push(`<div class="streak-day ${isCompletedDay(key)?"is-done":""} ${key===todayKey()?"is-today":""}" title="${escapeHTML(formatDateLong(key))}"><span>${persianDate(d,{weekday:"narrow"})}</span><strong>${isCompletedDay(key)?"✓":persianParts(d).day}</strong></div>`);}
    $("#streakDays").innerHTML=days.join("");
    const milestones=[{n:3,label:"شروع قوی"},{n:7,label:"یک هفته"},{n:14,label:"دو هفته"},{n:30,label:"یک ماه"},{n:100,label:"صد روز"}];
    $("#achievementList").innerHTML=milestones.map(m=>`<span class="achievement ${streak.best>=m.n?"unlocked":""}" title="${m.n} روز استریک"><b>${streak.best>=m.n?"🏆":"🔒"}</b>${m.label}</span>`).join("")+`<span class="achievement ${points>=100?"unlocked":""}" title="۱۰۰ امتیاز"><b>⭐</b>۱۰۰ امتیاز</span>`;
    const log=state.habitLogs[selectedDate]||[];$("#habitDateLabel").textContent=selectedDate===todayKey()?"امروز":formatDateLong(selectedDate);
    $("#habitList").innerHTML=state.habits.length?state.habits.map(h=>`<div class="tool-item habit-item"><label><input type="checkbox" data-habit-check="${escapeHTML(h.id)}" ${log.includes(h.id)?"checked":""}><span>${escapeHTML(h.title)}</span></label><button type="button" class="mini-delete" data-habit-delete="${escapeHTML(h.id)}" aria-label="حذف عادت">×</button></div>`).join(""):`<div class="empty-state">هنوز عادتی نساختی.</div>`;
    $("#goalList").innerHTML=state.goals.length?state.goals.map(g=>{const pct=Math.min(100,Math.round((Number(g.progress)||0)/Math.max(1,Number(g.target)||1)*100));return `<div class="goal-item" data-goal-id="${escapeHTML(g.id)}"><div class="goal-head"><strong>${escapeHTML(g.title)}</strong><button type="button" class="mini-delete" data-goal-delete="${escapeHTML(g.id)}" aria-label="حذف هدف">×</button></div><div class="goal-progress"><span style="width:${pct}%"></span></div><div class="goal-foot"><small>${faNumber(g.progress||0)} از ${faNumber(g.target||1)} قدم · ${faNumber(pct)}٪</small><div><button type="button" data-goal-step="-1" ${Number(g.progress)<=0?"disabled":""}>−</button><button type="button" data-goal-step="1" ${Number(g.progress)>=Number(g.target)?"disabled":""}>＋</button></div></div></div>`;}).join(""):`<div class="empty-state">اولین هدف یا پروژه‌ات رو اضافه کن.</div>`;
    $("#vaultNoteList").innerHTML=state.notes.length?[...state.notes].sort((a,b)=>(b.updatedAt||"").localeCompare(a.updatedAt||"")).map(n=>`<article class="vault-note" data-note-id="${escapeHTML(n.id)}"><div class="goal-head"><strong>${escapeHTML(n.title)}</strong><div class="note-actions"><button type="button" class="mini-edit" data-note-edit="${escapeHTML(n.id)}" aria-label="ویرایش یادداشت">ویرایش</button><button type="button" class="mini-delete" data-note-delete="${escapeHTML(n.id)}" aria-label="حذف یادداشت">×</button></div></div>${n.tag?`<span class="note-tag">${escapeHTML(n.tag)}</span>`:""}<p>${escapeHTML(n.body).replace(/\n/g,"<br>")}</p><small>${n.updatedAt?persianDate(new Date(n.updatedAt),{day:"numeric",month:"short"}):""}</small></article>`).join(""):`<div class="empty-state">یادداشت‌های ذخیره‌شده اینجا نمایش داده می‌شن.</div>`;
    renderSearchResults();
  }
  function applyPreferences(){
    const prefs=state.preferences||{};document.documentElement.dataset.theme=prefs.theme==="dark"?"dark":"light";
    document.documentElement.style.setProperty("--accent",/^#[0-9a-f]{6}$/i.test(prefs.accent||"")?prefs.accent:"#171717");
    const toggle=document.getElementById("darkModeToggle"), color=document.getElementById("accentColor");if(toggle)toggle.checked=prefs.theme==="dark";if(color)color.value=prefs.accent||"#171717";
  }
  function renderSearchResults(){
    const host=$("#searchResults");if(!host)return;const q=($("#globalSearch").value||"").trim().toLocaleLowerCase("fa");
    if(!q){host.innerHTML=`<div class="empty-state">برای جست‌وجو، چیزی بنویس.</div>`;return;}
    const results=[];
    Object.entries(state.days||{}).forEach(([date,data])=>{(data.tasks||[]).forEach(task=>{if((task.title||"").toLocaleLowerCase("fa").includes(q))results.push(`<button class="search-result" type="button" data-search-date="${date}"><span>کار · ${escapeHTML(task.title)}</span><small>${escapeHTML(formatDateLong(date))} · ${task.done?"انجام‌شده":"انجام‌نشده"}</small></button>`);});if((data.note||"").toLocaleLowerCase("fa").includes(q))results.push(`<button class="search-result" type="button" data-search-date="${date}"><span>یادداشت روز</span><small>${escapeHTML(formatDateLong(date))}</small></button>`);});
    state.notes.forEach(n=>{if(`${n.title} ${n.tag||""} ${n.body}`.toLocaleLowerCase("fa").includes(q))results.push(`<div class="search-result static-result"><span>یادداشت · ${escapeHTML(n.title)}</span><small>${escapeHTML(n.tag||"بدون برچسب")}</small></div>`);});
    state.habits.forEach(h=>{if(h.title.toLocaleLowerCase("fa").includes(q))results.push(`<div class="search-result static-result"><span>عادت · ${escapeHTML(h.title)}</span></div>`);});
    state.goals.forEach(g=>{if(g.title.toLocaleLowerCase("fa").includes(q))results.push(`<div class="search-result static-result"><span>هدف · ${escapeHTML(g.title)}</span></div>`);});
    host.innerHTML=results.length?results.slice(0,50).join(""):`<div class="empty-state">نتیجه‌ای پیدا نشد.</div>`;
  }
  $("#habitForm").addEventListener("submit",e=>{e.preventDefault();const title=$("#habitTitle").value.trim();if(!title)return;state.habits.push({id:makeId(),title,createdAt:new Date().toISOString()});$("#habitTitle").value="";persist();renderToolkit();notify("عادت جدید اضافه شد.");});
  $("#habitList").addEventListener("change",e=>{const id=e.target.dataset.habitCheck;if(!id)return;state.habitLogs[selectedDate]=state.habitLogs[selectedDate]||[];const set=new Set(state.habitLogs[selectedDate]);if(e.target.checked)set.add(id);else set.delete(id);state.habitLogs[selectedDate]=[...set];persist();renderToolkit();});
  $("#habitList").addEventListener("click",e=>{const id=e.target.dataset.habitDelete;if(!id)return;if(!confirm("این عادت حذف شود؟ ثبت‌های قبلی آن هم نگه داشته می‌شوند."))return;state.deletedHabitIds=[...new Set([...(state.deletedHabitIds||[]),id])];state.habits=state.habits.filter(h=>h.id!==id);persist();renderToolkit();});
  $("#goalForm").addEventListener("submit",e=>{e.preventDefault();const title=$("#goalTitle").value.trim(),target=Math.max(1,Number($("#goalTarget").value)||1);if(!title)return;state.goals.push({id:makeId(),title,target,progress:0,createdAt:new Date().toISOString()});$("#goalTitle").value="";persist();renderToolkit();notify("هدف جدید ثبت شد.");});
  $("#goalList").addEventListener("click",e=>{const del=e.target.dataset.goalDelete;if(del){if(!confirm("این هدف حذف شود؟"))return;state.deletedGoalIds=[...new Set([...(state.deletedGoalIds||[]),del])];state.goals=state.goals.filter(g=>g.id!==del);persist();renderToolkit();return;}const btn=e.target.closest("[data-goal-step]");if(!btn)return;const goal=state.goals.find(g=>g.id===btn.closest("[data-goal-id]")?.dataset.goalId);if(!goal)return;goal.progress=Math.max(0,Math.min(Number(goal.target)||1,(Number(goal.progress)||0)+Number(btn.dataset.goalStep)));persist();renderToolkit();if(goal.progress>=goal.target)notify("آفرین! به هدف «"+goal.title+"» رسیدی.");});
  $("#vaultNoteForm").addEventListener("submit",e=>{e.preventDefault();const title=$("#vaultNoteTitle").value.trim(),body=$("#vaultNoteBody").value.trim(),tag=$("#vaultNoteTag").value.trim();if(!title||!body)return;const editingId=$("#vaultNoteForm").dataset.editingId;const now=new Date().toISOString();if(editingId){const note=state.notes.find(n=>n.id===editingId);if(note)Object.assign(note,{title,body,tag,updatedAt:now});delete $("#vaultNoteForm").dataset.editingId;$("#vaultNoteForm button[type=submit]").textContent="ذخیره یادداشت";}else{state.notes.unshift({id:makeId(),title,body,tag,createdAt:now,updatedAt:now});}$("#vaultNoteTitle").value="";$("#vaultNoteTag").value="";$("#vaultNoteBody").value="";persist();renderToolkit();notify(editingId?"تغییرات یادداشت ذخیره شد.":"یادداشت ذخیره شد.");});
  $("#vaultNoteList").addEventListener("click",e=>{
    const editId=e.target.dataset.noteEdit;
    if(editId){const note=state.notes.find(n=>n.id===editId);if(!note)return;$("#vaultNoteTitle").value=note.title;$("#vaultNoteTag").value=note.tag||"";$("#vaultNoteBody").value=note.body;$("#vaultNoteForm").dataset.editingId=editId;$("#vaultNoteForm button[type=submit]").textContent="ذخیره تغییرات";$("#vaultNoteForm").scrollIntoView({behavior:"smooth",block:"center"});return;}
    const id=e.target.dataset.noteDelete;if(!id)return;if(!confirm("این یادداشت حذف شود؟"))return;state.deletedNoteIds=[...new Set([...(state.deletedNoteIds||[]),id])];state.notes=state.notes.filter(n=>n.id!==id);persist();renderToolkit();
  });
  $("#globalSearch").addEventListener("input",renderSearchResults);
  $("#taskFilter").addEventListener("change",()=>{renderTasks();});
  $("#searchResults").addEventListener("click",e=>{const btn=e.target.closest("[data-search-date]");if(!btn)return;editingTaskId=null;selectedDate=btn.dataset.searchDate;const d=dateFromISO(selectedDate);calendarAnchor=d;renderAll();document.querySelector(".day-panel").scrollIntoView({behavior:"smooth",block:"start"});});
  $("#darkModeToggle").addEventListener("change",e=>{state.preferences={...(state.preferences||{}),theme:e.target.checked?"dark":"light"};persist();applyPreferences();});
  $("#accentColor").addEventListener("input",e=>{state.preferences={...(state.preferences||{}),accent:e.target.value};applyPreferences();persist();});
  $("#exportBackup").addEventListener("click",()=>{const blob=new Blob([JSON.stringify({format:"roozno-backup",version:2,exportedAt:new Date().toISOString(),state},null,2)],{type:"application/json"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`roozno-backup-${todayKey()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify("فایل پشتیبان آماده شد.");});
  $("#importBackupButton").addEventListener("click",()=>$("#importBackupFile").click());
  $("#importBackupFile").addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text()),incoming=parsed.state||parsed;if(!incoming||typeof incoming!=="object"||!incoming.days||typeof incoming.days!=="object")throw new Error("invalid backup");if(!confirm("بازیابی، اطلاعات فعلی این دستگاه را با فایل پشتیبان جایگزین می‌کند. ادامه می‌دهی؟"))return;state={...defaultState(),...incoming,days:incoming.days||{},weekly:incoming.weekly||{},focusByDay:incoming.focusByDay||{},lastWeeklySeeded:incoming.lastWeeklySeeded||{},habits:Array.isArray(incoming.habits)?incoming.habits:[],habitLogs:incoming.habitLogs||{},goals:Array.isArray(incoming.goals)?incoming.goals:[],notes:Array.isArray(incoming.notes)?incoming.notes:[],deletedHabitIds:Array.isArray(incoming.deletedHabitIds)?incoming.deletedHabitIds:[],deletedGoalIds:Array.isArray(incoming.deletedGoalIds)?incoming.deletedGoalIds:[],deletedNoteIds:Array.isArray(incoming.deletedNoteIds)?incoming.deletedNoteIds:[],preferences:{theme:"light",accent:"#171717",...(incoming.preferences||{})},game:{bonusXP:0,claimedMissions:[],...(incoming.game||{})}};persist();renderAll();notify("پشتیبان بازیابی شد.");}catch(err){notify("فایل پشتیبان معتبر نیست.");}finally{e.target.value="";}});

  // Notifications. Local reminders work while this page is open; Web Push works after the server setup in PUSH_SETUP_FA.md.
  // Replace this placeholder with the VAPID PUBLIC key generated for your Supabase Edge Function. Never put the private key here.
  const VAPID_PUBLIC_KEY = "BHPa2QqMobWfZS72wvBFeBkKx0gPOWj4VmemiRNU8v0iid3gybLnzysTOxgZDeRSbmgFP-XK4cum0w28EEFCmZI";
  const notifiedReminderKeys = new Set();
  let reminderCheckTimer = null;

  function base64UrlToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
  }
  async function enableNotifications() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      notify("این مرورگر اعلان وب را پشتیبانی نمی‌کند؛ Chrome اندروید را امتحان کن."); return;
    }
    if (!window.isSecureContext) { notify("اعلان‌ها فقط روی HTTPS فعال می‌شوند."); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { notify("اجازه اعلان داده نشد؛ از تنظیمات سایت فعالش کن."); return; }
    notify("اعلان‌های این دستگاه فعال شد.");
    if (VAPID_PUBLIC_KEY.startsWith("PASTE_")) {
      notify("اعلان هنگام باز بودن روزنو فعال شد؛ برای اعلان در حالت بسته، تنظیمات سرور باقی مانده.");
      return;
    }
    if (!supabaseClient || !currentUser) {
      notify("برای اعلان حرفه‌ای، اول با گوگل وارد شو."); return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY) });
      const { error } = await supabaseClient.from("push_subscriptions").upsert({ user_id: currentUser.id, endpoint: subscription.endpoint, subscription: subscription.toJSON(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", updated_at: new Date().toISOString() }, { onConflict: "user_id,endpoint" });
      if (error) throw error;
      notify("اعلان حرفه‌ای این دستگاه فعال شد.");
    } catch (error) {
      console.error("Push subscription failed", error);
      notify("ثبت اعلان سرور انجام نشد؛ جدول و کلیدهای تنظیمات را بررسی کن.");
    }
  }
  function checkDueReminders() {
    if (!('Notification' in window) || Notification.permission !== "granted") return;
    const now = new Date();
    const today = todayKey();
    const tasks = (state.days?.[today]?.tasks || []).filter(task => task.time && !task.done);
    tasks.forEach(task => {
      const [hour, minute] = task.time.split(":").map(Number);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
      const key = `${today}:${task.id}`;
      if (now >= due && now.getTime() - due.getTime() < 60000 && !notifiedReminderKeys.has(key)) {
        notifiedReminderKeys.add(key);
        navigator.serviceWorker.ready.then(reg => reg.showNotification("روزنو · وقت برنامه‌ات رسیده", { body: task.title, icon: "./icons/icon-192.png", tag: `roozno-${key}`, data: { url: "./" } })).catch(() => { try { new Notification("روزنو · وقت برنامه‌ات رسیده", { body: task.title }); } catch (_) {} });
      }
    });
  }
  $("#enableNotificationsButton").addEventListener("click", enableNotifications);
  reminderCheckTimer = setInterval(checkDueReminders, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDueReminders(); });

  // Optional Supabase sync. Set credentials in this file; OAuth redirect must be allow-listed in Supabase.
  const SUPABASE_URL = "https://bqzrvmnzgytjpdlxbtup.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_hKjX142K3-bMnD8qnRlXKw_BCzYkU3T";
  function setProfileAvatar(img, fallback, rawUrl, altText=""){
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    let safeUrl = "";
    if (url) {
      try { const parsed = new URL(url, window.location.href); if (parsed.protocol === "https:") safeUrl = parsed.href; } catch (_) {}
    }
    img.onerror = () => { img.classList.add("hidden"); fallback.classList.remove("hidden"); };
    img.alt = altText;
    if (safeUrl) { img.src = safeUrl; img.classList.remove("hidden"); fallback.classList.add("hidden"); }
    else { img.removeAttribute("src"); img.classList.add("hidden"); fallback.classList.remove("hidden"); }
  }
  function openProfileModal(){
    if(!currentUser)return;
    const modal=$("#profileModal"); if(!modal)return;
    lastProfileTrigger=$("#userChip");
    modal.hidden=false;$("#userChip").setAttribute("aria-expanded","true");
    requestAnimationFrame(()=>$("#closeProfileButton")?.focus());
  }
  function closeProfileModal(){
    const modal=$("#profileModal");if(!modal)return;
    modal.hidden=true;$("#userChip").setAttribute("aria-expanded","false");
    if(lastProfileTrigger && !lastProfileTrigger.classList.contains("hidden"))lastProfileTrigger.focus();
  }
  $("#userChip").addEventListener("click",openProfileModal);
  $("#closeProfileButton").addEventListener("click",closeProfileModal);
  $("#profileModal").addEventListener("click",event=>{if(event.target===$("#profileModal"))closeProfileModal();});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!$("#profileModal").hidden)closeProfileModal();});

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
    const metadata=user?.user_metadata||{};
    const email=user?.email||"ایمیل ثبت نشده";
    const displayName=metadata.full_name||metadata.name||metadata.display_name||(email.includes("@")?email.split("@")[0]:"حساب گوگل");
    const photo=metadata.avatar_url||metadata.picture||metadata.photo_url||"";
    $("#loginButton").classList.add("hidden");$("#userChip").classList.remove("hidden");
    $("#profileDisplayName").textContent=displayName;
    $("#profileEmail").textContent=email;
    $("#profileConnectionStatus").textContent="متصل به گوگل";
    setProfileAvatar($("#userAvatarImage"),$("#userAvatarFallback"),photo,displayName);
    setProfileAvatar($("#profileAvatarImage"),$("#profileAvatarFallback"),photo,displayName);
    setSyncStatus("حساب متصل است؛ آماده‌ی همگام‌سازی");
  }
  function showLoggedOut(){
    closeProfileModal();
    $("#loginButton").classList.remove("hidden");$("#userChip").classList.add("hidden");
    $("#profileDisplayName").textContent="حساب گوگل";$("#profileEmail").textContent="—";$("#profileConnectionStatus").textContent="متصل نیست";
    setProfileAvatar($("#userAvatarImage"),$("#userAvatarFallback"),"","");
    setProfileAvatar($("#profileAvatarImage"),$("#profileAvatarFallback"),"","");
    setSyncStatus("اطلاعات روی همین دستگاه ذخیره می‌شود");
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
          Object.keys(state.focusByDay || {}).length > 0 || (state.habits||[]).length > 0 || (state.goals||[]).length > 0 || (state.notes||[]).length > 0
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
          merged.habits = [...new Map([...(cloud.habits||[]), ...(state.habits||[])].map(item=>[item.id,item])).values()];
          merged.habitLogs = {...(cloud.habitLogs||{}), ...(state.habitLogs||{})};
          merged.goals = [...new Map([...(cloud.goals||[]), ...(state.goals||[])].map(item=>[item.id,item])).values()];
          merged.notes = [...new Map([...(cloud.notes||[]), ...(state.notes||[])].map(item=>[item.id,item])).values()];
          merged.deletedHabitIds = [...new Set([...(cloud.deletedHabitIds||[]), ...(state.deletedHabitIds||[])])];
          merged.deletedGoalIds = [...new Set([...(cloud.deletedGoalIds||[]), ...(state.deletedGoalIds||[])])];
          merged.deletedNoteIds = [...new Set([...(cloud.deletedNoteIds||[]), ...(state.deletedNoteIds||[])])];
          merged.habits = merged.habits.filter(item=>!merged.deletedHabitIds.includes(item.id));
          merged.goals = merged.goals.filter(item=>!merged.deletedGoalIds.includes(item.id));
          merged.notes = merged.notes.filter(item=>!merged.deletedNoteIds.includes(item.id));
          merged.preferences = {...(cloud.preferences||{}), ...(state.preferences||{})};
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