-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0005_device_names.sql
--
-- 1.5 之前 devices.name 由「浏览器 · 系统」自动拼接（例如 Chrome · Windows），
-- 那时还没有改名功能，所以这些值一定是自动生成的，可以安全归一化为默认设备名。
--
-- 只匹配旧的自动命名格式，用户自定义名称（不含 " · "）不会被覆盖。
-- ---------------------------------------------------------------------------

UPDATE devices
   SET name = CASE device_type
                WHEN 'laptop' THEN 'My Laptop'
                WHEN 'tablet' THEN 'My Tablet'
                WHEN 'mobile' THEN 'My Phone'
                ELSE 'My Desktop'
              END
 WHERE name LIKE '% · %'
   AND name NOT IN ('My Desktop', 'My Laptop', 'My Tablet', 'My Phone');
