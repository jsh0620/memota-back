// archive.js (경로: memota-back/routes/archive.js)
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /archive/:userId — 보관함 불러오기
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('archives')
      .select('archive_data')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: '불러오기 실패' });
    }

    return res.json({ archive: data?.archive_data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /archive/:userId — 보관함 저장
router.put('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { archive } = req.body;

    const { error } = await supabase
      .from('archives')
      .upsert({ user_id: userId, archive_data: archive }, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: '저장 실패' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
