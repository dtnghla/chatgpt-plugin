DATABASE sales;
CREATE MULTISET TABLE sales.orders ,NO FALLBACK ,NO BEFORE JOURNAL
(
  order_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  order_date DATE FORMAT 'YYYY-MM-DD' NOT NULL,
  status CHAR(1) CHARACTER SET LATIN NOT CASESPECIFIC,
  total DECIMAL(12,2),
  note VARCHAR(200) CHARACTER SET UNICODE
)
PRIMARY INDEX (order_id)
PARTITION BY RANGE_N(order_date BETWEEN DATE '2020-01-01' AND DATE '2030-12-31' EACH INTERVAL '1' MONTH);
CREATE SET TABLE sales.customers
(
  customer_id INTEGER NOT NULL,
  name VARCHAR(100) CHARACTER SET UNICODE NOT CASESPECIFIC,
  segment BYTEINT,
  valid_period PERIOD(DATE),
  profile CLOB
)
UNIQUE PRIMARY INDEX (customer_id);
CREATE MULTISET TABLE sales.order_lines
(
  order_id INTEGER NOT NULL,
  line_no SMALLINT NOT NULL,
  sku VARCHAR(40),
  qty INTEGER,
  amount DECIMAL(12,2)
)
PRIMARY INDEX (order_id, line_no);
CREATE VOLATILE TABLE vt_stage (id INTEGER) ON COMMIT PRESERVE ROWS;
REPLACE VIEW sales.order_totals_v AS LOCKING ROW FOR ACCESS
SEL o.order_id, ZEROIFNULL(o.total) AS total FROM sales.orders o;
CREATE MACRO sales.refresh_totals AS (
  DELETE FROM sales.order_totals;
  INSERT INTO sales.order_totals SELECT order_id, total FROM sales.orders;
);
