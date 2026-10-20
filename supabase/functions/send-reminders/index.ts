import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const cronSecret = Deno.env.get("CRON_SECRET")!;
const db = createClient(supabaseUrl, serviceRoleKey);
webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const now = new Date();
    const { data: planners, error: plannerError } = await db.from("planner_data").select("user_id,payload");
    if (plannerError) throw plannerError;
    let sent = 0;
    const errors: string[] = [];
    for (const planner of planners || []) {
      const { data: subscriptions, error: subError } = await db.from("push_subscriptions").select("id,endpoint,subscription,timezone").eq("user_id", planner.user_id);
      if (subError) throw subError;
      if (!subscriptions?.length) continue;
      const timezone = subscriptions[0].timezone || "UTC";
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
      const part = (type: string) => parts.find(p => p.type === type)?.value || "";
      const dateKey = `${part("year")}-${part("month")}-${part("day")}`;
      const minuteKey = `${part("hour")}:${part("minute")}`;
      const tasks = planner.payload?.days?.[dateKey]?.tasks || [];
      for (const task of tasks) {
        if (!task?.id || !task?.title || task.done || task.time !== minuteKey) continue;
        const { data: alreadySent, error: checkError } = await db.from("sent_reminders").select("id").eq("user_id", planner.user_id).eq("task_id", String(task.id)).eq("task_date", dateKey).maybeSingle();
        if (checkError) throw checkError;
        if (alreadySent) continue;
        for (const row of subscriptions) {
          try {
            await webpush.sendNotification(row.subscription, JSON.stringify({
              title: "روزنو · وقت برنامه‌ات رسیده",
              body: task.title,
              tag: `roozno-${dateKey}-${task.id}`,
              url: "/"
            }));
            sent++;
          } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await db.from("push_subscriptions").delete().eq("id", row.id);
            } else {
              errors.push(`push failed for ${planner.user_id}: ${String(error)}`);
            }
          }
        }
        const { error: logError } = await db.from("sent_reminders").insert({ user_id: planner.user_id, task_id: String(task.id), task_date: dateKey });
        if (logError && !String(logError.message).includes("duplicate key")) throw logError;
      }
    }
    return Response.json({ ok: true, checkedAt: now.toISOString(), sent, errors });
  } catch (error) {
    console.error(error);
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});
