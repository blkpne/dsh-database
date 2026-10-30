-- 仅在独立的空 PostgreSQL 示例数据库中运行；重复执行会报错，不覆盖已有表。
BEGIN;

CREATE TABLE public.orders (
  order_id integer PRIMARY KEY,
  paid_at date NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  amount_cents integer NOT NULL
);

CREATE TABLE public.refunds (
  refund_id integer PRIMARY KEY,
  order_id integer REFERENCES public.orders(order_id),
  amount_cents integer NOT NULL
);

COMMENT ON TABLE public.orders IS
  '合成电商订单，金额为人民币分。status=paid 才计入成交；canceled 不计入。';
COMMENT ON TABLE public.refunds IS
  '合成退款，一笔订单可有多次退款。先按 order_id 汇总，再关联订单，避免重复计算成交额。';

DO $$
DECLARE
  plan record;
  item integer;
  next_order integer := 1;
  next_refund integer := 1;
BEGIN
  FOR plan IN
    SELECT * FROM (VALUES
      (1, '自然搜索', 200, 20000, 10, 10000),
      (1, '付费广告', 150, 30000, 20, 18000),
      (1, '老客复购',  50, 30000,  4, 10000),
      (2, '自然搜索', 250, 20000, 10, 12500),
      (2, '付费广告', 200, 30000, 30, 15000),
      (2, '老客复购',  50, 30000,  5, 10000),
      (3, '自然搜索', 270, 20000, 15,  9000),
      (3, '付费广告', 280, 30000, 80, 20000),
      (3, '老客复购',  50, 24000,  5, 13000)
    ) AS plans(month, channel, paid_orders, amount, refunded_orders, refund)
  LOOP
    FOR item IN 0..plan.paid_orders - 1 LOOP
      INSERT INTO public.orders VALUES (
        next_order, make_date(2026, plan.month, item % 28 + 1),
        plan.channel, 'paid', plan.amount
      );
      IF item < plan.refunded_orders THEN
        INSERT INTO public.refunds VALUES
          (next_refund, next_order, plan.refund / 2),
          (next_refund + 1, next_order, plan.refund - plan.refund / 2);
        next_refund := next_refund + 2;
      END IF;
      next_order := next_order + 1;
    END LOOP;
  END LOOP;

  FOR month IN 1..3 LOOP
    FOR item IN 1..20 LOOP
      INSERT INTO public.orders VALUES (
        next_order, make_date(2026, month, 15), '付费广告', 'canceled', 99900
      );
      next_order := next_order + 1;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
