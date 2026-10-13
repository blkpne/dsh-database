-- 金额单位：元。退款先按订单汇总，避免一笔订单多次退款导致成交额重复。
WITH refunded AS (
  SELECT order_id, SUM(amount_cents) AS refund_cents
  FROM public.refunds
  GROUP BY order_id
)
SELECT
  to_char(o.paid_at, 'YYYY-MM') AS month,
  COUNT(*) AS paid_orders,
  SUM(o.amount_cents) / 100.0 AS gross,
  SUM(COALESCE(r.refund_cents, 0)) / 100.0 AS refunds,
  SUM(o.amount_cents - COALESCE(r.refund_cents, 0)) / 100.0 AS net,
  ROUND(100.0 * SUM(COALESCE(r.refund_cents, 0)) / SUM(o.amount_cents), 2) AS refund_rate_pct
FROM public.orders o
LEFT JOIN refunded r USING (order_id)
WHERE o.status = 'paid' AND o.paid_at >= DATE '2026-01-01' AND o.paid_at < DATE '2026-04-01'
GROUP BY 1
ORDER BY 1;

-- 季度渠道退款率：退款金额 / 已支付成交额，而非退款订单占比。
WITH refunded AS (
  SELECT order_id, SUM(amount_cents) AS refund_cents
  FROM public.refunds
  GROUP BY order_id
)
SELECT
  o.channel,
  ROUND(100.0 * SUM(COALESCE(r.refund_cents, 0)) / SUM(o.amount_cents), 2) AS refund_rate_pct
FROM public.orders o
LEFT JOIN refunded r USING (order_id)
WHERE o.status = 'paid' AND o.paid_at >= DATE '2026-01-01' AND o.paid_at < DATE '2026-04-01'
GROUP BY o.channel
ORDER BY refund_rate_pct DESC;
