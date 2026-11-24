-- The following assertion runs before either legacy trigger is removed.
INSERT INTO rehearsal_write_guards(id,allowed)
SELECT 'v14-recording-protection-required',CASE WHEN (
 SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN (
  'rehearsal_protect_recording','rehearsal_protect_release_reference','rehearsal_protect_recording_origin'
 )
)=3 THEN 1 ELSE 0 END;

DROP TRIGGER IF EXISTS rehearsal_keep_three;
DROP TRIGGER IF EXISTS rehearsal_locked_limit;
