-- 扩充状态字段以满足 SaaS 阶段化需求
alter type public.job_status_enum add value if not exists 'grouping';
alter type public.job_status_enum add value if not exists 'grouped';
alter type public.job_status_enum add value if not exists 'merging_fake';
alter type public.job_status_enum add value if not exists 'processing';

alter type public.job_group_status_enum add value if not exists 'merging_fake';
alter type public.job_group_status_enum add value if not exists 'processing';
