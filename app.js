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
  // Signed-in accounts use separate local caches. The legacy anonymous cache is never
  // merged into an account, preventing one person's local data from being uploaded to another account.
  function storageKeyForUser(){ return currentUser ? `${STORAGE_KEY}:user:${currentUser.id}` : STORAGE_KEY; }
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

  const defaultState = () => ({days:{}, weekly:{}, focusSeconds:0, focusByDay:{}, lastWeeklySeeded:{}, habits:[], habitLogs:{}, goals:[], notes:[], deletedHabitIds:[], deletedGoalIds:[], deletedNoteIds:[], deletedTaskIds:[], deletedWeeklyIds:[], preferences:{theme:"light",accent:"#8be34b"}, game:{bonusXP:0,claimedMissions:[]}});
  let state = defaultState();
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
  let timerRemainingAtStart = timerRemaining, lastTimerValue = timerRemaining;
  let toastTimer = null;

  function loadState(key = storageKeyForUser()){
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (parsed && typeof parsed === "object") return {...defaultState(), ...parsed, days:parsed.days||{}, weekly:parsed.weekly||{}, focusByDay:parsed.focusByDay||{}, lastWeeklySeeded:parsed.lastWeeklySeeded||{}, habits:Array.isArray(parsed.habits)?parsed.habits:[], habitLogs:parsed.habitLogs||{}, goals:Array.isArray(parsed.goals)?parsed.goals:[], notes:Array.isArray(parsed.notes)?parsed.notes:[], deletedHabitIds:Array.isArray(parsed.deletedHabitIds)?parsed.deletedHabitIds:[], deletedGoalIds:Array.isArray(parsed.deletedGoalIds)?parsed.deletedGoalIds:[], deletedNoteIds:Array.isArray(parsed.deletedNoteIds)?parsed.deletedNoteIds:[], deletedTaskIds:Array.isArray(parsed.deletedTaskIds)?parsed.deletedTaskIds:[], deletedWeeklyIds:Array.isArray(parsed.deletedWeeklyIds)?parsed.deletedWeeklyIds:[], preferences:{theme:"light",accent:"#8be34b",...(parsed.preferences||{})}, game:{bonusXP:0,claimedMissions:[],...(parsed.game||{})}};
    } catch (error) { console.warn("Could not load planner data", error); }
    return defaultState();
  }
  function saveLocal(key = storageKeyForUser()){ try { localStorage.setItem(key, JSON.stringify(state)); } catch (error) { console.warn("Could not save locally", error); } }
  function addTombstone(listName, id){ state[listName] = [...new Set([...(state[listName]||[]), id])]; }
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
    const data = state.days[key] || {tasks:[], note:"", finalized:null};
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
      // Timestamp the completion state so another device can resolve stale local copies.
      task.doneUpdatedAt = new Date().toISOString();
      if(selectedDate<todayKey() && !data.finalized) data.finalized=data.tasks.length&&data.tasks.every(t=>t.done)?"complete":"incomplete";
      persist();renderTasks();renderCalendar();renderStats();renderToolkit();
      if(task.done && data.tasks.length && data.tasks.every(t=>t.done)) notify("آفرین! همه برنامه‌های این روز انجام شد.");
    }else if(action.classList.contains("task-delete")){
      data.tasks=data.tasks.filter(t=>t.id!==task.id);addTombstone("deletedTaskIds",task.id);editingTaskId=null;persist();renderTasks();renderCalendar();renderStats();renderToolkit();notify("برنامه حذف شد.");
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
    task.title=title;task.time=time;task.updatedAt=new Date().toISOString();editingTaskId=null;persist();renderTasks();renderCalendar();notify("برنامه ویرایش شد.");
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
    addTombstone("deletedWeeklyIds",row.dataset.weeklyId);
    // Remove not-yet-completed instances created from this template; keep past task history.
    Object.entries(state.days).forEach(([dateKey,day])=>{
      // Past task history is immutable, even when a recurring template is removed.
      if(dateKey < todayKey()) return;
      day.tasks=(day.tasks||[]).filter(t=>{
        const remove = t.templateId===row.dataset.weeklyId && !t.done;
        if (remove) addTombstone("deletedTaskIds",t.id);
        return !remove;
      });
    });
    persist();renderWeekly();renderTasks();renderCalendar();notify("برنامه تکرارشونده حذف شد.");
  });
  let noteSaveTimer=null;
  $("#dailyNote").addEventListener("input",()=>{
    const note=$("#dailyNote").value;$("#noteCharCount").textContent=`${faNumber(note.length)} / ۵۰۰۰`;
    $("#noteSaveState").textContent="در حال ذخیره…";
    clearTimeout(noteSaveTimer);noteSaveTimer=setTimeout(()=>{const nd=dayData(selectedDate);nd.note=note;nd.noteUpdatedAt=new Date().toISOString();persist();$("#noteSaveState").textContent="ذخیره شد";},350);
  });
  $$("[data-minutes]").forEach(btn=>btn.addEventListener("click",()=>{
    if(timerRunning){notify("اول تایمر رو متوقف کن.");return;}
    timerDuration=Number(btn.dataset.minutes)*60;timerRemaining=timerDuration;renderTimer();
  }));
  $("#timerStart").addEventListener("click",()=>{
    if(timerRunning){pauseTimer();return;}
    if(timerRemaining<=0){timerRemaining=timerDuration;}
    timerRemainingAtStart=timerRemaining;lastTimerValue=timerRemaining;
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
  // XP is earned only by completing daily missions. Tasks, habits and focus time
  // are progress signals; they do not grant XP independently.
  function getPoints(){
    const rewards=Object.fromEntries(Object.entries(MISSION_CATALOG).map(([id,mission])=>[id,mission.reward]));
    const missionPoints=[...new Set(state.game?.claimedMissions||[])].reduce((sum,claim)=>{
      const missionId=String(claim).slice(String(claim).lastIndexOf(":")+1);
      return sum+(Number(rewards[missionId])||0);
    },0);
    return missionPoints + Math.max(0, Number(state.game?.snakeXP)||0);
  }
  const MISSION_CATALOG = {
    tasks2: {title:"انجام ۲ کار امروز", reward:15, test:(tasks)=>tasks.filter(t=>t.done).length>=2, progress:(tasks)=>`${Math.min(2,tasks.filter(t=>t.done).length)} از ۲`},
    tasks3: {title:"انجام ۳ کار امروز", reward:20, test:(tasks)=>tasks.filter(t=>t.done).length>=3, progress:(tasks)=>`${Math.min(3,tasks.filter(t=>t.done).length)} از ۳`},
    tasks5: {title:"انجام ۵ کار امروز", reward:30, test:(tasks)=>tasks.filter(t=>t.done).length>=5, progress:(tasks)=>`${Math.min(5,tasks.filter(t=>t.done).length)} از ۵`},
    habit1: {title:"ثبت یک عادت امروز", reward:10, test:(_tasks,habits)=>habits.length>=1, progress:(_tasks,habits)=>`${Math.min(1,habits.length)} از ۱`},
    habit2: {title:"ثبت ۲ عادت امروز", reward:20, test:(_tasks,habits)=>habits.length>=2, progress:(_tasks,habits)=>`${Math.min(2,habits.length)} از ۲`},
    focus15: {title:"۱۵ دقیقه تمرکز", reward:15, test:(_tasks,_habits,focus)=>focus>=900, progress:(_tasks,_habits,focus)=>`${Math.min(15,Math.floor(focus/60))} از ۱۵ دقیقه`},
    focus25: {title:"۲۵ دقیقه تمرکز", reward:25, test:(_tasks,_habits,focus)=>focus>=1500, progress:(_tasks,_habits,focus)=>`${Math.min(25,Math.floor(focus/60))} از ۲۵ دقیقه`},
    focus45: {title:"۴۵ دقیقه تمرکز", reward:35, test:(_tasks,_habits,focus)=>focus>=2700, progress:(_tasks,_habits,focus)=>`${Math.min(45,Math.floor(focus/60))} از ۴۵ دقیقه`},
    perfect: {title:"تکمیل همه کارهای امروز", reward:30, test:(tasks)=>tasks.length>0&&tasks.every(t=>t.done), progress:(tasks)=>tasks.length?`${tasks.filter(t=>t.done).length} از ${tasks.length}`:"اول کار اضافه کن"},
    note: {title:"یادداشت روزانه بنویس", reward:10, test:(_tasks,_habits,_focus,data)=>String(data.note||"").trim().length>=20, progress:(_tasks,_habits,_focus,data)=>`${Math.min(20,String(data.note||"").trim().length)} از ۲۰ نویسه`}
  };
  // Each weekday has its own mission pool. Four missions are selected per day;
  // the omitted mission rotates every Saturday, so the weekly set changes.
  const WEEKDAY_MISSION_POOLS = {
    6:["tasks2","habit1","focus15","perfect","note"],
    0:["tasks3","habit2","focus25","note","tasks5"],
    1:["tasks2","habit1","focus45","perfect","focus15"],
    2:["tasks5","habit1","focus25","note","perfect"],
    3:["tasks3","habit2","focus15","perfect","note"],
    4:["tasks2","habit2","focus45","tasks5","note"],
    5:["tasks3","habit1","focus25","perfect","focus45"]
  };
  function currentWeekStart(date = new Date()){
    const start = new Date(date.getFullYear(),date.getMonth(),date.getDate());
    start.setDate(start.getDate()-((start.getDay()+1)%7)); // Saturday start
    return start;
  }
  function dailyMissionData(){
    const key=todayKey(), date=dateFromISO(key), data=state.days?.[key]||{tasks:[],note:""}, tasks=data.tasks||[], habits=state.habitLogs?.[key]||[], focus=Number(state.focusByDay?.[key])||0;
    const weekNumber=Math.floor((currentWeekStart(date).getTime()-new Date(1970,0,3).getTime())/604800000);
    const pool=WEEKDAY_MISSION_POOLS[date.getDay()]||WEEKDAY_MISSION_POOLS[6];
    const omitIndex=((weekNumber%pool.length)+pool.length)%pool.length;
    return pool.filter((_id,index)=>index!==omitIndex).map(id=>{
      const m=MISSION_CATALOG[id];
      return {id,title:m.title,reward:m.reward,ok:m.test(tasks,habits,focus,data),progress:m.progress(tasks,habits,focus,data)};
    });
  }
  const missionXPInFlight = new Set();
  const missionXPSyncedThisSession = new Set();
  async function syncMissionXPToLeaderboard(missionId){
    // The browser never sends an XP amount. The database owns the reward table,
    // checks today's Tehran schedule, and enforces one event per user/mission/day.
    if(!supabaseClient || !currentUser) return;
    const localClaimKey = `${todayKey()}:${missionId}`;
    if(missionXPInFlight.has(localClaimKey) || missionXPSyncedThisSession.has(localClaimKey)) return;
    missionXPInFlight.add(localClaimKey);
    try{
      const {data,error}=await supabaseClient.rpc("claim_daily_mission_xp",{p_mission_id:missionId});
      if(error) throw error;
      if(data?.ok===false) throw new Error(data.reason||"Mission is not scheduled for today");
      missionXPSyncedThisSession.add(localClaimKey);
      await loadLeaderboard();
    }catch(error){
      // Keep it retryable on the next render/reload; local XP remains separate.
      console.warn("Could not sync mission XP to leaderboard",error);
      socialStatus("XP محلی ثبت شد، اما ثبت جهانی ناموفق بود؛ مهاجرت SQL مأموریت‌ها را اجرا کن.");
    }finally{ missionXPInFlight.delete(localClaimKey); }
  }
  function claimCompletedMissions(){
    if(!state.game)state.game={bonusXP:0,claimedMissions:[]};
    if(!Array.isArray(state.game.claimedMissions))state.game.claimedMissions=[];
    let gained=0;
    const missions=dailyMissionData();
    missions.forEach(m=>{
      const claimKey=`${todayKey()}:${m.id}`;
      if(m.ok&&!state.game.claimedMissions.includes(claimKey)){
        state.game.claimedMissions.push(claimKey);
        state.game.bonusXP=(Number(state.game.bonusXP)||0)+m.reward;
        gained+=m.reward;
      }
      // Existing local claims are also synced, so upgrading the app can backfill
      // today's already-completed missions without trusting a client-supplied amount.
      if(m.ok&&state.game.claimedMissions.includes(claimKey)) void syncMissionXPToLeaderboard(m.id);
    });
    if(gained){persist();notify(`مأموریت انجام شد! ${faNumber(gained)} XP جایزه گرفتی.`);}
  }
  function renderGame(points){
    const levelIndex=GAME_LEVELS.reduce((idx,l,i)=>points>=l.xp?i:idx,0), level=GAME_LEVELS[levelIndex], next=GAME_LEVELS[levelIndex+1];
    $("#playerLevel").textContent=`سطح ${faNumber(levelIndex+1)} · ${level.name}`;$("#xpTotal").textContent=`${faNumber(points)} XP`;
    const pct=next?Math.max(0,Math.min(100,((points-level.xp)/(next.xp-level.xp))*100)):100;
    $("#xpProgress").style.width=`${pct}%`;
    $("#xpNextText").textContent=next?`${faNumber(next.xp-points)} XP تا سطح بعدی (${next.name})`:"به بالاترین سطح رسیدی؛ افسانه‌ای هستی!";
    const dn=document.getElementById("dashboardName"), sourceName=document.getElementById("profileDisplayName");if(dn&&sourceName&&sourceName.textContent.trim()&&sourceName.textContent.trim()!=="حساب گوگل")dn.textContent=sourceName.textContent.trim();
    const dashAvatar=document.getElementById("dashboardAvatar"), profilePhoto=document.getElementById("profileAvatarImage"), fallbackPhoto=document.getElementById("profileAvatarFallback");if(dashAvatar&&profilePhoto&&!profilePhoto.classList.contains("hidden")&&profilePhoto.src){dashAvatar.innerHTML="";const img=document.createElement("img");img.src=profilePhoto.src;img.alt="";img.style.cssText="width:100%;height:100%;object-fit:cover;border-radius:16px";dashAvatar.appendChild(img);}else if(dashAvatar){const nm=(document.getElementById("profileDisplayName")?.textContent||"ر").trim();dashAvatar.textContent=nm&&nm!=="حساب گوگل"?nm.slice(0,1):"ر";}
    const dl=document.getElementById("dashboardLevel"), db=document.getElementById("dashboardXPBar"), dx=document.getElementById("dashboardXPLabel"), dnxt=document.getElementById("dashboardNextLevel"), dt=document.getElementById("dashboardTotalXP"), dtb=document.getElementById("dashboardTotalXPBar");
    if(dl)dl.textContent=`سطح ${faNumber(levelIndex+1)} · ${level.name}`;if(db)db.style.width=pct+"%";if(dx)dx.textContent=`${faNumber(points-level.xp)} / ${faNumber(next?next.xp-level.xp:level.xp||100)} XP`;if(dnxt)dnxt.textContent=next?`${faNumber(next.xp-points)} XP تا سطح بعدی`:"بالاترین سطح باز شده!";if(dt)dt.innerHTML=`${faNumber(points)} <small>XP</small>`;if(dtb)dtb.style.width=Math.min(100,points%1000/10)+"%";
    $("#dailyMissions").innerHTML=dailyMissionData().map(m=>{const claimed=(state.game?.claimedMissions||[]).includes(`${todayKey()}:${m.id}`);return `<div class="game-row ${m.ok||claimed?"mission-done":""}"><span class="game-icon">${claimed?"✓":"🎯"}</span><div class="game-row-text"><strong>${escapeHTML(m.title)}</strong><small>${escapeHTML(m.progress)} · جایزه ${faNumber(m.reward)} XP</small></div><b>${claimed?"گرفته شد":m.ok?"تکمیل شد":"در انتظار"}</b></div>`;}).join("");
    $("#unlockableFeatures").innerHTML=GAME_UNLOCKS.map(u=>{const unlocked=points>=u.xp;return `<div class="game-row ${unlocked?"mission-done":"locked-feature"}"><span class="game-icon">${unlocked?u.icon:"🔒"}</span><div class="game-row-text"><strong>${escapeHTML(u.title)}</strong><small>${escapeHTML(u.desc)}</small></div><b>${unlocked?"باز شد":`${faNumber(u.xp)} XP`}</b></div>`;}).join("");
  }
  function renderToolkit(){
    if(!document.getElementById("currentStreak"))return;
    claimCompletedMissions();
    const streak=getStreakStats(), points=getPoints();
    renderGame(points);
    $("#currentStreak").textContent=faNumber(streak.current);$("#bestStreak").textContent=faNumber(streak.best);$("#totalPoints").textContent=faNumber(points);
    const ds=document.getElementById("dashboardStreak"),dsb=document.getElementById("dashboardStreakBar");if(ds)ds.innerHTML=`${faNumber(streak.current)} <small>روز</small>`;if(dsb)dsb.style.width=Math.min(100,streak.current/30*100)+"%";
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
    document.documentElement.style.setProperty("--accent",/^#[0-9a-f]{6}$/i.test(prefs.accent||"")?prefs.accent:"#8be34b");
    document.documentElement.style.setProperty("--accent-soft",(/^#[0-9a-f]{6}$/i.test(prefs.accent||"")?prefs.accent:"#8be34b")+"22");
    const toggle=document.getElementById("darkModeToggle"), color=document.getElementById("accentColor");if(toggle)toggle.checked=prefs.theme==="dark";if(color)color.value=prefs.accent||"#8be34b";
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
  $("#goalList").addEventListener("click",e=>{const del=e.target.dataset.goalDelete;if(del){if(!confirm("این هدف حذف شود؟"))return;state.deletedGoalIds=[...new Set([...(state.deletedGoalIds||[]),del])];state.goals=state.goals.filter(g=>g.id!==del);persist();renderToolkit();return;}const btn=e.target.closest("[data-goal-step]");if(!btn)return;const goal=state.goals.find(g=>g.id===btn.closest("[data-goal-id]")?.dataset.goalId);if(!goal)return;goal.progress=Math.max(0,Math.min(Number(goal.target)||1,(Number(goal.progress)||0)+Number(btn.dataset.goalStep)));goal.updatedAt=new Date().toISOString();persist();renderToolkit();if(goal.progress>=goal.target)notify("آفرین! به هدف «"+goal.title+"» رسیدی.");});
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
  $("#importBackupFile").addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text()),incoming=parsed.state||parsed;if(!incoming||typeof incoming!=="object"||!incoming.days||typeof incoming.days!=="object")throw new Error("invalid backup");if(!confirm("بازیابی، اطلاعات فعلی این دستگاه را با فایل پشتیبان جایگزین می‌کند. ادامه می‌دهی؟"))return;state={...defaultState(),...incoming,days:incoming.days||{},weekly:incoming.weekly||{},focusByDay:incoming.focusByDay||{},lastWeeklySeeded:incoming.lastWeeklySeeded||{},habits:Array.isArray(incoming.habits)?incoming.habits:[],habitLogs:incoming.habitLogs||{},goals:Array.isArray(incoming.goals)?incoming.goals:[],notes:Array.isArray(incoming.notes)?incoming.notes:[],deletedHabitIds:Array.isArray(incoming.deletedHabitIds)?incoming.deletedHabitIds:[],deletedGoalIds:Array.isArray(incoming.deletedGoalIds)?incoming.deletedGoalIds:[],deletedNoteIds:Array.isArray(incoming.deletedNoteIds)?incoming.deletedNoteIds:[],deletedTaskIds:Array.isArray(incoming.deletedTaskIds)?incoming.deletedTaskIds:[],deletedWeeklyIds:Array.isArray(incoming.deletedWeeklyIds)?incoming.deletedWeeklyIds:[],preferences:{theme:"light",accent:"#8be34b",...(incoming.preferences||{})},game:{bonusXP:0,claimedMissions:[],...(incoming.game||{})}};persist();renderAll();notify("پشتیبان بازیابی شد.");}catch(err){notify("فایل پشتیبان معتبر نیست.");}finally{e.target.value="";}});

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
        navigator.serviceWorker.ready.then(reg => reg.showNotification("روزنو · وقت برنامه‌ات رسیده", { body: task.title, icon: "./icons/icon-192.png", tag: `roozno-${today}-${task.id}`, data: { url: "./" } })).catch(() => { try { new Notification("روزنو · وقت برنامه‌ات رسیده", { body: task.title }); } catch (_) {} });
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

  // Public profiles, friend requests and weekly leaderboard. Privileged XP awards are server-only.
  const $id = id => document.getElementById(id);
  function socialStatus(message){ const el=$id("socialStatus"); if(el)el.textContent=message||""; }
  function safeText(value){ return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  async function ensurePublicProfile(){
    if(!supabaseClient||!currentUser)return null;
    const meta=currentUser.user_metadata||{};
    const suggested=String(meta.full_name||meta.name||meta.display_name||"").trim().slice(0,40);
    const {data,error}=await supabaseClient.from("profiles").select("user_id,display_name").eq("user_id",currentUser.id).maybeSingle();
    if(error)throw error;
    if(data){$id("publicUserId").textContent=data.user_id;$id("publicDisplayName").value=data.display_name||"";return data;}
    const {data:created,error:createError}=await supabaseClient.from("profiles").insert({user_id:currentUser.id,display_name:null}).select("user_id,display_name").single();
    if(createError)throw createError;
    $id("publicUserId").textContent=created.user_id;$id("publicDisplayName").value=suggested;
    return created;
  }
  async function savePublicProfile(event){
    event.preventDefault();if(!currentUser||!supabaseClient)return;
    const name=$id("publicDisplayName").value.trim();
    if(name.length<2||name.length>40){socialStatus("نام نمایشی باید بین ۲ تا ۴۰ نویسه باشد.");return;}
    const {error}=await supabaseClient.from("profiles").update({display_name:name}).eq("user_id",currentUser.id);
    if(error){socialStatus("ذخیره ناموفق بود؛ ابتدا مهاجرت SQL و سیاست‌های پروفایل را بررسی کن.");console.error(error);return;}
    socialStatus("نام نمایشی ذخیره شد.");await loadFriendsAndRequests();await loadLeaderboard();
  }
  async function searchFriend(event){
    event.preventDefault();if(!supabaseClient||!currentUser)return;
    const id=$id("friendSearchId").value.trim();const target=$id("friendSearchResult");
    if(id===currentUser.id){target.innerHTML='<p class="social-muted">نمی‌توانی خودت را اضافه کنی.</p>';return;}
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){target.innerHTML='<p class="social-muted">UUID معتبر وارد کن.</p>';return;}
    const {data,error}=await supabaseClient.from("profiles").select("user_id,display_name").eq("user_id",id).maybeSingle();
    if(error){target.innerHTML='<p class="social-muted">جست‌وجو انجام نشد؛ مهاجرت دیتابیس را بررسی کن.</p>';return;}
    if(!data){target.innerHTML='<p class="social-muted">کاربری با این شناسه پیدا نشد.</p>';return;}
    target.innerHTML=`<div class="social-card"><div class="social-card-copy"><strong>${safeText(data.display_name||"کاربر روزنو")}</strong><small>${safeText(data.user_id)}</small></div><div class="social-card-actions"><button type="button" data-friend-action="send" data-user-id="${safeText(data.user_id)}">درخواست دوستی</button></div></div>`;
  }
  async function sendFriendRequest(targetId){
    if(!supabaseClient||!currentUser)return;
    const {error}=await supabaseClient.from("friend_requests").insert({requester_id:currentUser.id,addressee_id:targetId});
    if(error){socialStatus(error.code==="23505"?"درخواست تکراری است یا قبلاً رابطه‌ای ثبت شده.":"ارسال درخواست انجام نشد؛ ممکن است درخواست معلق یا دوستی موجود باشد.");return;}
    socialStatus("درخواست دوستی ارسال شد.");await loadFriendsAndRequests();
  }
  async function friendRequestAction(action,requestId){
    const rpc={accept:"accept_friend_request",reject:"reject_friend_request",cancel:"cancel_friend_request"}[action];if(!rpc||!supabaseClient)return;
    const {error}=await supabaseClient.rpc(rpc,{p_request_id:requestId});
    if(error){socialStatus("عملیات انجام نشد؛ بررسی کن مهاجرت SQL کامل اجرا شده باشد.");console.error(error);return;}
    socialStatus("درخواست به‌روزرسانی شد.");await loadFriendsAndRequests();
  }
  async function removeFriend(friendId){
    if(!supabaseClient||!confirm("این کاربر از فهرست دوستانت حذف شود؟"))return;
    const {error}=await supabaseClient.rpc("remove_friend",{p_friend_id:friendId});
    if(error){socialStatus("حذف دوست انجام نشد.");return;}socialStatus("دوست حذف شد.");await loadFriendsAndRequests();
  }
  async function loadFriendsAndRequests(){
    if(!supabaseClient||!currentUser)return;
    const reqBox=$id("friendRequestsList"),friendsBox=$id("friendsList");
    try{
      const {data:requests,error:rerr}=await supabaseClient.from("friend_requests").select("id,requester_id,created_at,profiles!friend_requests_requester_id_fkey(user_id,display_name)").eq("addressee_id",currentUser.id).eq("status","pending").order("created_at",{ascending:false});
      if(rerr)throw rerr;
      reqBox.innerHTML=requests?.length?requests.map(r=>`<div class="social-card"><div class="social-card-copy"><strong>${safeText(r.profiles?.display_name||"کاربر روزنو")}</strong><small>${safeText(r.requester_id)}</small></div><div class="social-card-actions"><button data-friend-action="accept" data-request-id="${safeText(r.id)}">پذیرفتن</button><button data-friend-action="reject" data-request-id="${safeText(r.id)}">رد</button></div></div>`).join(""):'<p class="social-muted">درخواست دریافتی نداری.</p>';
      const {data:outgoing,error:oerr}=await supabaseClient.from("friend_requests").select("id,addressee_id,created_at,profiles!friend_requests_addressee_id_fkey(user_id,display_name)").eq("requester_id",currentUser.id).eq("status","pending").order("created_at",{ascending:false});
      if(oerr)throw oerr;
      const outgoingBox=$id("outgoingRequestsList");
      outgoingBox.innerHTML=outgoing?.length?outgoing.map(r=>`<div class="social-card"><div class="social-card-copy"><strong>${safeText(r.profiles?.display_name||"کاربر روزنو")}</strong><small>${safeText(r.addressee_id)}</small></div><div class="social-card-actions"><button data-friend-action="cancel" data-request-id="${safeText(r.id)}">لغو درخواست</button></div></div>`).join(""):'<p class="social-muted">درخواست ارسالی معلق نداری.</p>';
      const {data:friends,error:ferr}=await supabaseClient.rpc("list_my_friends");if(ferr)throw ferr;
      friendsBox.innerHTML=friends?.length?friends.map(f=>`<div class="social-card"><div class="social-card-copy"><strong>${safeText(f.display_name||"کاربر روزنو")}</strong><small>${safeText(f.user_id)}<br>رکورد عمومی: ${faNumber(Number(f.public_streak)||0)} روز · نشان‌ها: ${Array.isArray(f.public_achievements)&&f.public_achievements.length?safeText(f.public_achievements.join("، ")):"هنوز نشانی ثبت نشده"}</small></div><div class="social-card-actions"><button data-friend-action="remove" data-user-id="${safeText(f.user_id)}">حذف</button></div></div>`).join(""):'<p class="social-muted">هنوز دوستی اضافه نکردی.</p>';
    }catch(error){console.warn("Social data unavailable",error);reqBox.innerHTML='<p class="social-muted">درخواست‌ها در دسترس نیستند؛ SQL migration را اجرا کن.</p>';if($id("outgoingRequestsList"))$id("outgoingRequestsList").innerHTML='<p class="social-muted">در دسترس نیست.</p>';friendsBox.innerHTML='<p class="social-muted">فهرست دوستان در دسترس نیست.</p>';}
  }
  async function loadLeaderboard(){
    const rankEl=$id("dashboardRank"), caption=$id("dashboardRankCaption");
    if(!supabaseClient||!currentUser){if(rankEl)rankEl.textContent="—";if(caption)caption.textContent="برای نمایش رتبه وارد حساب شو";return;}
    const box=$id("leaderboardList");if(box)box.innerHTML='<p class="social-muted">در حال دریافت رتبه‌بندی…</p>';
    try{
      const {data,error}=await supabaseClient.rpc("get_weekly_leaderboard");if(error)throw error;
      const rows=data?.top||[];const own=data?.current_user;
      if(rankEl)rankEl.textContent=own?.rank?`#${faNumber(own.rank)}`:"—";
      if(caption)caption.textContent=own?`${faNumber(Number(own.weekly_xp)||0)} XP این هفته`:"هنوز امتیاز هفتگی ثبت نکردی";
      const chart=$id("weeklyRankLine");if(chart){const pts=rows.slice(0,7).map((r,i)=>({x:2+i*(216/Math.max(1,Math.min(6,rows.length-1))),y:38-Math.min(30,(Number(r.weekly_xp)||0)/Math.max(1,...rows.map(x=>Number(x.weekly_xp)||0))*30)}));chart.setAttribute("d",pts.length>1?pts.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' '):"M2 38 L218 38");}
      if(box)box.innerHTML=(rows.length?rows.map(row=>`<div class="social-card"><span class="social-rank">${safeText(row.rank)}</span><div class="social-card-copy"><strong>${safeText(row.display_name||"کاربر روزنو")}</strong><small>${safeText(row.user_id)}</small></div><strong>${faNumber(Number(row.weekly_xp)||0)} XP</strong></div>`).join(""):'<p class="social-muted">هنوز امتیاز هفتگی معتبری ثبت نشده است.</p>')+(own&&!rows.some(r=>r.user_id===currentUser.id)?`<div class="social-current-rank">رتبهٔ تو: ${own.rank?faNumber(own.rank):"بدون رتبه"} · امتیاز این هفته: ${faNumber(Number(own.weekly_xp)||0)} XP</div>`:"");
    }catch(error){console.warn("Leaderboard unavailable",error);if(rankEl)rankEl.textContent="—";if(caption)caption.textContent="جدول هفتگی در دسترس نیست";if(box)box.innerHTML='<p class="social-muted">رتبه‌بندی هنوز آماده نیست. مهاجرت‌های SQL را اجرا کن.</p>';}
  }
  function bindSocialUI(){
    $id("publicProfileForm")?.addEventListener("submit",savePublicProfile);
    $id("friendSearchForm")?.addEventListener("submit",searchFriend);
    $id("refreshLeaderboard")?.addEventListener("click",loadLeaderboard);
    document.addEventListener("click",event=>{
      const button=event.target.closest("[data-friend-action]");if(!button)return;
      const action=button.dataset.friendAction;
      if(action==="send")sendFriendRequest(button.dataset.userId);
      else if(action==="remove")removeFriend(button.dataset.userId);
      else friendRequestAction(action,button.dataset.requestId);
    });
  }
  async function initializeSocial(){
    if(!currentUser||!supabaseClient)return;
    try{
      const profile=await ensurePublicProfile();await loadFriendsAndRequests();await loadLeaderboard();
      if(profile&&!profile.display_name){openProfileModal();socialStatus("برای تکمیل پروفایل، یک نام نمایشی انتخاب کن.");$id("publicDisplayName")?.focus();}
    }catch(error){console.warn("Profile initialization failed",error);socialStatus("پروفایل عمومی آماده نیست؛ مهاجرت SQL را اجرا کن.");}
  }
  bindSocialUI();

  async function setupSupabase(){
    const configured=!SUPABASE_URL.includes("YOUR_PROJECT")&&!SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
    $("#loginButton").addEventListener("click", loginWithGoogle);
    if(!configured){
      state = loadState();
      renderAll();
      setSyncStatus("تنظیمات Supabase در app.js کامل نیست");
      return;
    }
    if(!window.supabase){
      state = loadState();
      renderAll();
      setSyncStatus("کتابخانه Supabase بارگذاری نشد؛ اتصال اینترنت یا CDN را بررسی کن");
      return;
    }
    supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
    const {data:{session}}=await supabaseClient.auth.getSession();
    let syncedUserId=null;
    if(session){currentUser=session.user;showUser(currentUser);syncedUserId=currentUser.id;await syncFromCloud();await initializeSocial();}
    else { currentUser=null; state=defaultState(); showLoggedOut(); renderAll(); }
    supabaseClient.auth.onAuthStateChange((_event,session)=>{
      // Never await Supabase calls directly inside this callback; defer them.
      setTimeout(async()=>{
        currentUser=session?.user||null;
        if(currentUser){
          showUser(currentUser);
          if(syncedUserId!==currentUser.id){syncedUserId=currentUser.id;await syncFromCloud();await initializeSocial();}
        } else {
          syncedUserId=null;
          currentUser=null;
          state=defaultState();
          showLoggedOut();
          renderAll();
        }
      },0);
    });
    $("#logoutButton").addEventListener("click",async()=>{await supabaseClient.auth.signOut();});
    if(!currentUser) setSyncStatus("برای همگام‌سازی، با گوگل وارد شو");
    else await initializeSocial();
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
      const accountKey = storageKeyForUser();
      const accountLocalRaw = localStorage.getItem(accountKey);
      // Start from this account's cache only. Never merge the old device-wide cache into
      // a signed-in account: that could leak one user's data into another user's cloud row.
      state = accountLocalRaw ? loadState(accountKey) : defaultState();
      setSyncStatus("دریافت اطلاعات آنلاین…");
      const {data,error}=await supabaseClient.from("planner_data").select("payload").eq("user_id",currentUser.id).maybeSingle();
      if(error)throw error;
      if(data?.payload){
        const cloud = {...defaultState(), ...data.payload};
        const localRaw = accountLocalRaw;
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
            // Merge tasks by ID. In older records there is no completion timestamp,
            // so prefer the cloud's done value rather than letting stale local state win.
            for (const task of (c.tasks||[])) taskMap.set(task.id, {...task});
            for (const localTask of (l.tasks||[])) {
              const cloudTask = taskMap.get(localTask.id);
              if (!cloudTask) {
                taskMap.set(localTask.id, {...localTask});
                continue;
              }
              const mergedTask = {...cloudTask, ...localTask};
              const cloudDoneAt = Date.parse(cloudTask.doneUpdatedAt || "") || 0;
              const localDoneAt = Date.parse(localTask.doneUpdatedAt || "") || 0;
              if (localDoneAt > cloudDoneAt) {
                mergedTask.done = localTask.done;
                mergedTask.doneUpdatedAt = localTask.doneUpdatedAt;
              } else {
                mergedTask.done = cloudTask.done;
                if (cloudTask.doneUpdatedAt) mergedTask.doneUpdatedAt = cloudTask.doneUpdatedAt;
                else delete mergedTask.doneUpdatedAt;
              }
              const cloudUpdatedAt = Date.parse(cloudTask.updatedAt || "") || 0;
              const localUpdatedAt = Date.parse(localTask.updatedAt || "") || 0;
              if (cloudUpdatedAt > localUpdatedAt) {
                mergedTask.title = cloudTask.title;
                mergedTask.time = cloudTask.time;
                if (cloudTask.updatedAt) mergedTask.updatedAt = cloudTask.updatedAt;
              }
              taskMap.set(localTask.id, mergedTask);
            }
            const deletedTasks = new Set([...(cloud.deletedTaskIds||[]), ...(state.deletedTaskIds||[])]);
            const cNoteAt = Date.parse(c.noteUpdatedAt || "") || 0, lNoteAt = Date.parse(l.noteUpdatedAt || "") || 0;
            const pickLocalNote = lNoteAt || cNoteAt ? lNoteAt >= cNoteAt : !!l.note;
            merged.days[key] = {...c, ...l, tasks:[...taskMap.values()].filter(t=>!deletedTasks.has(t.id)),
              note:(pickLocalNote ? (l.note || "") : (c.note || "")), noteUpdatedAt:(pickLocalNote ? l.noteUpdatedAt : c.noteUpdatedAt) || undefined,
              finalized:l.finalized || c.finalized || null};
          }
          for (const key of new Set([...Object.keys(cloud.weekly||{}), ...Object.keys(state.weekly||{})])) {
            const templates = new Map();
            [...(cloud.weekly?.[key]||[]), ...(state.weekly?.[key]||[])].forEach(item => templates.set(item.id, item));
            const deletedTemplates = new Set([...(cloud.deletedWeeklyIds||[]), ...(state.deletedWeeklyIds||[])]);
            merged.weekly[key] = [...templates.values()].filter(t=>!deletedTemplates.has(t.id));
          }
          merged.focusByDay = {...cloud.focusByDay, ...state.focusByDay};
          merged.focusSeconds = Math.max(Number(cloud.focusSeconds||0), Number(state.focusSeconds||0));
          merged.lastWeeklySeeded = {...cloud.lastWeeklySeeded, ...state.lastWeeklySeeded};
          merged.habits = [...new Map([...(cloud.habits||[]), ...(state.habits||[])].map(item=>[item.id,item])).values()];
          merged.habitLogs = {...(cloud.habitLogs||{}), ...(state.habitLogs||{})};
          const newest = (a, b) => ((b.updatedAt||"") > (a.updatedAt||"") ? b : a);
          const mergeById = (cloudItems, localItems) => { const map = new Map(); (cloudItems||[]).forEach(i=>map.set(i.id,i)); (localItems||[]).forEach(i=>map.set(i.id, map.has(i.id) ? newest(i, map.get(i.id)) : i)); return [...map.values()]; };
          merged.goals = mergeById(cloud.goals, state.goals);
          merged.notes = mergeById(cloud.notes, state.notes);
          merged.deletedTaskIds = [...new Set([...(cloud.deletedTaskIds||[]), ...(state.deletedTaskIds||[])])];
          merged.deletedWeeklyIds = [...new Set([...(cloud.deletedWeeklyIds||[]), ...(state.deletedWeeklyIds||[])])];
          merged.game = {...(cloud.game||{}), ...(state.game||{}), bonusXP: Math.max(Number(cloud.game?.bonusXP)||0, Number(state.game?.bonusXP)||0), claimedMissions: [...new Set([...(cloud.game?.claimedMissions||[]), ...(state.game?.claimedMissions||[])])]};
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

  // Refresh shared state when a device returns to the foreground.
  let lastForegroundSync = 0;
  async function refreshCloudOnForeground(){
    if (!supabaseClient || !currentUser || document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - lastForegroundSync < 2500) return;
    lastForegroundSync = now;
    await syncFromCloud();
  }
  window.addEventListener("focus", refreshCloudOnForeground);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCloudOnForeground();
  });

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
  // Redesigned side navigation and modal-style section views.
  const drawer=document.getElementById("sideDrawer"),scrim=document.getElementById("drawerScrim"),menuToggle=document.getElementById("menuToggle"),viewModal=document.getElementById("sectionViewModal"),viewContent=document.getElementById("sectionViewContent"),viewTitle=document.getElementById("sectionViewTitle");
  const movedNodes=[];
  function openDrawer(){drawer.classList.add("open");scrim.classList.add("show");drawer.setAttribute("aria-hidden","false");menuToggle?.setAttribute("aria-expanded","true");}
  function closeDrawer(){drawer.classList.remove("open");scrim.classList.remove("show");drawer.setAttribute("aria-hidden","true");menuToggle?.setAttribute("aria-expanded","false");}
  function restoreViewNodes(){movedNodes.splice(0).forEach(({node,placeholder})=>{if(placeholder.parentNode)placeholder.parentNode.insertBefore(node,placeholder);placeholder.remove();});viewContent.replaceChildren();}
  function showSectionView(key){closeDrawer();if(key==="profile"){openProfileModal();return;}if(key==="home"){closeSectionView();document.querySelectorAll(".drawer-nav [data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===key));window.scrollTo({top:0,behavior:"smooth"});return;}
    restoreViewNodes();const configs={missions:{title:"مأموریت‌های روزانه",selectors:[".game-panel"]},leaderboard:{title:"رتبه‌بندی هفتگی",selectors:["#leaderboardTitle"]},settings:{title:"تنظیمات روزنو",selectors:[".settings-panel"]}};const config=configs[key];if(!config)return;viewTitle.textContent=config.title;
    config.selectors.forEach(selector=>{const found=document.querySelector(selector);if(!found)return;let node=found;if(key==="leaderboard"){node=found.closest(".social-section")||found;}const placeholder=document.createComment("roozno-view-placeholder");node.parentNode.insertBefore(placeholder,node);movedNodes.push({node,placeholder});viewContent.appendChild(node);});
    if(key==="missions"){const note=document.createElement("p");note.className="section-description view-note";note.textContent="مأموریت‌های روزانه‌ات رو تکمیل کن و مسیر پیشرفتت رو ادامه بده.";viewContent.prepend(note);}
    if(key==="leaderboard"){const box=viewContent.querySelector("#leaderboardList");if(box){const refresh=document.createElement("button");refresh.className="button button-light";refresh.textContent="به‌روزرسانی جدول";refresh.type="button";refresh.addEventListener("click",()=>document.getElementById("refreshLeaderboard")?.click());viewContent.appendChild(refresh);}}
    viewModal.hidden=false;document.body.classList.add("modal-open");document.querySelectorAll(".drawer-nav [data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===key));viewModal.querySelector(".section-view-dialog").focus();
  }
  function closeSectionView(){if(!viewModal)return;viewModal.hidden=true;restoreViewNodes();document.body.classList.remove("modal-open");}
  menuToggle?.addEventListener("click",openDrawer);document.getElementById("closeDrawer")?.addEventListener("click",closeDrawer);scrim?.addEventListener("click",closeDrawer);
  drawer?.querySelectorAll("[data-view]").forEach(button=>button.addEventListener("click",()=>showSectionView(button.dataset.view)));
  document.getElementById("closeSectionView")?.addEventListener("click",closeSectionView);viewModal?.addEventListener("click",e=>{if(e.target===viewModal)closeSectionView();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeDrawer();if(viewModal&&!viewModal.hidden)closeSectionView();}});
  document.querySelector(".brand")?.addEventListener("click",e=>{e.preventDefault();showSectionView("home");});

  finalizeExpiredDays();
  // Initialize timer bookkeeping and UI.
  renderAll();
  setupSupabase();
})();