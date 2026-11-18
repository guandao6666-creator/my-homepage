-- Guandao OS 2.0 · 移除邀请制收尾：删除 community_invites
--
-- 背景：2026-11-18 邀请制已从代码中彻底移除（提交 cb15ba0），
-- 表内只剩 2 条已作废的邀请记录，不再有任何读写路径。
--
-- 备份：执行前已导出完整快照
--   .wrangler/guandao-db-before-drop-invites-20261118-2242.sql
--
-- 回滚方式：重新执行 0009_community.sql 中 community_invites 的建表与索引语句，
-- 再从快照里恢复数据行。表为空也能正常工作（代码已不引用）。
--
-- 本文件是 check-migrations 白名单里唯一允许 DROP TABLE 的迁移，
-- 因为它删除的是一张已经完全失去引用的表。

DROP TABLE IF EXISTS community_invites;
