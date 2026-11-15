CREATE OR REPLACE PACKAGE hr.emp_pkg AS
  PROCEDURE raise_salary(p_id NUMBER, p_pct NUMBER);
END emp_pkg;
/
CREATE OR REPLACE PACKAGE BODY hr.emp_pkg AS
  PROCEDURE raise_salary(p_id NUMBER, p_pct NUMBER) IS
    TYPE id_list IS TABLE OF NUMBER;
    v_ids id_list;
  BEGIN
    SELECT employee_id BULK COLLECT INTO v_ids FROM hr.employees WHERE department_id = p_id;
    EXECUTE IMMEDIATE 'UPDATE hr.employees SET salary = salary * (1 + :1 / 100) WHERE department_id = :2' USING p_pct, p_id;
    COMMIT;
  EXCEPTION
    WHEN OTHERS THEN
      ROLLBACK;
      RAISE;
  END raise_salary;
END emp_pkg;
/
CREATE OR REPLACE TRIGGER hr.emp_bi
BEFORE INSERT ON hr.employees FOR EACH ROW
BEGIN
  :NEW.employee_id := hr.employees_seq.NEXTVAL;
END;
/
CREATE OR REPLACE FUNCTION hr.get_salary(p_id NUMBER) RETURN NUMBER IS
  v_salary NUMBER;
BEGIN
  SELECT salary INTO v_salary FROM hr.employees WHERE employee_id = p_id;
  RETURN v_salary;
END;
/
