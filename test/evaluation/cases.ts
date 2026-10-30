const net = `WITH net AS (
  SELECT o.*, o.amount_cents - COALESCE(r.refunded, 0) AS net_cents
  FROM orders o LEFT JOIN (SELECT order_id, SUM(amount_cents) AS refunded FROM refunds GROUP BY order_id) r ON r.order_id = o.id
  WHERE o.status = 'paid'
)`;
export const evaluations = [
  {
    question:
      '在固定的 2025 年第一季度商业数据中，先发现表与关联字段，再计算所有已付款订单扣除全部退款后的客户净收入。净收入最高的客户名称是什么？只返回名称。',
    answer: 'Aster',
    sql: `${net} SELECT c.name FROM net n JOIN customers c ON c.id=n.customer_id GROUP BY c.id ORDER BY SUM(n.net_cents) DESC LIMIT 1`,
  },
  {
    question:
      '检查客户、订单及退款结构后，计算 2025 年第一季度东部地区已付款订单的净收入，避免一个订单多笔退款导致重复计算。只返回整数分。',
    answer: '60000',
    sql: `${net} SELECT SUM(n.net_cents) FROM net n JOIN customers c ON c.id=n.customer_id WHERE c.region='East'`,
  },
  {
    question:
      '发现订单和退款字段，核对退款可能分多笔的情况。2025 年第一季度有多少笔已付款订单的累计退款等于订单金额？只返回整数。',
    answer: '1',
    sql: `${net} SELECT COUNT(*) FROM net WHERE net_cents=0`,
  },
  {
    question:
      '发现表结构并按月汇总，排除未付款及取消订单，扣除每笔订单的全部退款。2025 年第一季度净收入最高的月份是什么？只返回 YYYY-MM。',
    answer: '2025-03',
    sql: `${net} SELECT month FROM net GROUP BY month ORDER BY SUM(net_cents) DESC LIMIT 1`,
  },
  {
    question:
      '检查订单状态及客户关联，找出在 2025 年一月和三月都至少有一笔已付款订单的客户。全额退款订单仍算已付款订单。只返回客户数量。',
    answer: '3',
    sql: `${net} SELECT COUNT(*) FROM (SELECT customer_id FROM net WHERE month IN ('2025-01','2025-03') GROUP BY customer_id HAVING COUNT(DISTINCT month)=2) x`,
  },
  {
    question:
      '检查客户、订单和退款关联，按客户计算第一季度退款总额除以已付款订单原始金额总额。退款率最高的客户是哪位？只返回名称。',
    answer: 'Dune',
    sql: `${net} SELECT c.name FROM net n JOIN customers c ON c.id=n.customer_id GROUP BY c.id ORDER BY 1.0*SUM(n.amount_cents-n.net_cents)/SUM(n.amount_cents) DESC LIMIT 1`,
  },
  {
    question:
      '发现客户及订单结构，核对全部客户（注意结果行数上限）。哪位客户在 2025 年第一季度没有任何已付款订单，但存在待付款订单？只返回名称。',
    answer: 'Elm',
    sql: `SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=c.id AND o.status='paid') AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=c.id AND o.status='pending')`,
  },
  {
    question:
      '检查订单和退款结构，区分退款记录数与退款订单数。2025 年第一季度出现多笔退款的已付款订单，扣除这些退款后的净金额合计是多少？只返回整数分。',
    answer: '20000',
    sql: `${net} SELECT SUM(net_cents) FROM net WHERE id IN (SELECT order_id FROM refunds GROUP BY order_id HAVING COUNT(*)>1)`,
  },
  {
    question:
      '发现相关字段后，比较西部地区与北部地区 2025 年第一季度的净收入，只统计已付款订单并扣除全部退款。西部比北部多多少？只返回整数分。',
    answer: '18000',
    sql: `${net} SELECT SUM(CASE WHEN c.region='West' THEN n.net_cents WHEN c.region='North' THEN -n.net_cents ELSE 0 END) FROM net n JOIN customers c ON c.id=n.customer_id`,
  },
  {
    question:
      '检查客户与订单结构，按稳定主键遍历所有客户，不能把截断的结果当成完整列表。第一季度有已付款订单的客户中，谁的已付款订单数量最多？只返回名称。',
    answer: 'Aster',
    sql: `${net} SELECT c.name FROM net n JOIN customers c ON c.id=n.customer_id GROUP BY c.id ORDER BY COUNT(*) DESC LIMIT 1`,
  },
];
