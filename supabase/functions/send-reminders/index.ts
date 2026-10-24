import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT");
const cronSecret = Deno.env.get("CRON_SECRET");

if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !cronSecret) {
  throw new Error("Missing required server secrets for send-reminders");
}

const db = createClient(supabaseUrl, serviceRoleKey);
webpush.setVapidDetails(vapidSubject || "mailto:admin@example.com", vapidPublicKey, vapidPrivateKey);

function localDateAndMinute(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { dateKey: `${part("year")}-${part("month")}-${part("day")}`, minuteKey: `${part("hour")}:${part("minute")}` };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("x-cron-secret") !== cronSecret) return new Response("Unauthorized", { status: 401 });

  try {
    const now = new Date();
    const { data: planners, error: plannerError } = await db.from("planner_data").select("user_id,payload");
    if (plannerError) throw plannerError;

    let sent = 0;
    let checked = 0;
    const errors: string[] = [];

    for (const planner of planners || []) {
      const { data: subscriptions, error: subError } = await db
        .from("push_subscriptions")
        .select("id,endpoint,subscription,timezone")
        .eq("user_id", planner.user_id);
      if (subError) throw subError;
      if (!subscriptions?.length) continue;

      for (const row of subscriptions) {
        let when: { dateKey: string; minuteKey: string };
        try {
          when = localDateAndMinute(now, row.timezone || "UTC");
        } catch {
          errors.push(`Invalid timezone on subscription ${row.id}`);
          continue;
        }

        const tasks = planner.payload?.days?.[when.dateKey]?.tasks || [];
        for (const task of tasks) {
          if (!task?.id || !task?.title || task.done || task.time !== when.minuteKey) continue;
          checked++;
          const taskId = String(task.id);

          const { data: delivered, error: deliveredError } = await db
            .from("push_delivery_log")
            .select("id")
            .eq("user_id", planner.user_id)
            .eq("subscription_id", row.id)
            .eq("task_id", taskId)
            .eq("task_date", when.dateKey)
            .maybeSingle();
          if (deliveredError) throw deliveredError;
          if (delivered) continue;

          try {
            await webpush.sendNotification(row.subscription, JSON.stringify({
              title: "روزنو · وقت برنامه‌ات رسیده",
              body: task.title,
              tag: `roozno-${when.dateKey}-${taskId}`,
              url: "./"
            }));

            const { error: logError } = await db.from("push_delivery_log").insert({
              user_id: planner.user_id,
              subscription_id: row.id,
              task_id: taskId,
              task_date: when.dateKey
            });
            if (logError && !String(logError.message).toLowerCase().includes("duplicate key")) throw logError;
            sent++;
          } catch (error) {
            const statusCode = (error as { statusCode?: number })?.statusCode;
            if (statusCode === 404 || statusCode === 410) {
              const { error: deleteError } = await db.from("push_subscriptions").delete().eq("id", row.id).eq("user_id", planner.user_id);
              if (deleteError) errors.push(`Could not remove expired subscription ${row.id}`);
            } else {
              // Do not write a delivery record on failure; the next cron run can retry.
              errors.push(`Push delivery failed for subscription ${row.id}: ${String(error)}`);
            }
          }
        }
      }
    }

    return Response.json({ ok: errors.length === 0, checked, sent, errors }, { status: errors.length ? 207 : 200 });
  } catch (error) {
    console.error("send-reminders failed", error);
    return Response.json({ ok: false, error: "Reminder processing failed" }, { status: 500 });
  }
});
