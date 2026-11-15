CREATE DATABASE IF NOT EXISTS sales;
USE sales;
CREATE EXTERNAL TABLE orders (
  order_id BIGINT,
  customer_id INT,
  amount DECIMAL(12,2),
  status STRING,
  tags ARRAY<STRING>,
  attrs MAP<STRING,STRING>
)
PARTITIONED BY (order_date STRING)
STORED AS PARQUET
LOCATION 'hdfs://namenode:8020/data/sales/orders';
CREATE TABLE customers (
  customer_id INT,
  name VARCHAR(100),
  country CHAR(2),
  segment TINYINT
)
CLUSTERED BY (customer_id) INTO 8 BUCKETS
STORED AS ORC;
CREATE TABLE order_events (
  event_id BIGINT,
  payload STRING,
  ts TIMESTAMP
)
STORED AS ORC
TBLPROPERTIES ('transactional'='true');
CREATE EXTERNAL TABLE clicks (
  session_id STRING,
  url STRING,
  ts TIMESTAMP
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
STORED AS TEXTFILE
LOCATION 's3a://legacy-clickstream/clicks/'
TBLPROPERTIES ('skip.header.line.count'='1');
CREATE VIEW order_summary_v AS
SELECT customer_id, NVL(SUM(amount), 0) AS total FROM orders GROUP BY customer_id;
