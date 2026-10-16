-- 014: an explicit, labelled OWNER EXCEPTION for review -> tested. Everything else in the lifecycle is unchanged: the content
-- hash gates, the exact-version rule and the one-published-per-code rule still apply. An exception never counts as a human review
-- or a blind playtest; it is recorded as blind_playtest = not_performed with who approved it and why, and shown in the admin UI.
create or replace function transition_case_status(p_case_id uuid, p_to text, p_actor text, p_record jsonb default '{}'::jsonb)
returns text language plpgsql as $$
declare c cases%rowtype; allowed boolean;
begin
  select * into c from cases where id = p_case_id for update;
  if not found then raise exception 'case not found'; end if;
  if c.status = p_to then return c.status; end if;
  allowed := (c.status, p_to) in (
    ('draft', 'review'), ('review', 'draft'), ('review', 'tested'), ('tested', 'review'), ('tested', 'published'),
    ('draft', 'disabled'), ('review', 'disabled'), ('tested', 'disabled'), ('published', 'disabled'), ('disabled', 'review'));
  if not allowed then raise exception 'illegal case status transition % -> %', c.status, p_to; end if;
  if c.content_hash is not null then
    if p_to = 'review' and c.status = 'draft' and c.validated_hash is distinct from c.content_hash then
      raise exception 'automated validation has not passed for this exact content version';
    end if;
    if p_to = 'tested' then
      -- Normal path: a named human reviewer and a completed blind playtest. The ONLY alternative is an explicit, labelled
      -- owner exception (who approved it and why). It is stored as such (blind_playtest = 'not_performed') and is never
      -- recorded as a review or a playtest.
      if coalesce(p_record->>'owner_exception', '') = 'true' then
        if coalesce(p_record->>'approved_by', '') = '' or coalesce(p_record->>'reason', '') = '' then
          raise exception 'an owner exception needs approved_by and a reason';
        end if;
        if p_record->>'blind_playtest' is distinct from 'not_performed' then
          raise exception 'an owner exception must record blind_playtest as not_performed';
        end if;
      elsif coalesce(p_record->>'reviewer', '') = '' or coalesce(p_record->>'blind_playtest', '') <> 'completed' then
        raise exception 'tested requires a named human reviewer and a completed blind playtest of this exact version';
      end if;
      update cases set tested_hash = c.content_hash, review_record = c.review_record || p_record || jsonb_build_object('tested_at', now()) where id = c.id;
    end if;
    if p_to = 'published' and (c.tested_hash is distinct from c.content_hash or c.validated_hash is distinct from c.content_hash) then
      raise exception 'only the exact version that was validated and tested can be published';
    end if;
  end if;
  if p_to = 'published' then
    update cases set status = 'disabled' where case_code = c.case_code and status = 'published' and id <> c.id;
    update cases set published_at = now() where id = c.id;
  end if;
  update cases set status = p_to where id = c.id;
  insert into admin_audit (action, actor, case_id, details)
  values ('case_status_changed', p_actor, c.id, jsonb_build_object('case_code', c.case_code, 'content_version', c.content_version, 'from', c.status, 'to', p_to) || case when p_to = 'tested' and p_record->>'owner_exception' = 'true' then jsonb_build_object('owner_exception', true, 'approved_by', p_record->>'approved_by', 'reason', p_record->>'reason') else '{}'::jsonb end);
  return p_to;
end $$;
