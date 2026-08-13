/*
 * cloud-config.js — Supabase の接続先
 *
 * ★ ここに URL と anon キーを貼ると「クラウド保存」が有効になる。
 *   空のままなら今までどおり、この PC の中だけで動く (ローカルのみモード)。
 *
 * ┌ url ─────── Supabase の Project URL   (https://xxxxxxxx.supabase.co)
 * ├ anonKey ─── anon public キー
 * ├ email ───── 共有アカウントのメールアドレス
 * └ bucket ──── Storage のバケット名
 *
 * anon キーは「公開してよい鍵」として設計されているので、この公開リポジトリに
 * 置いて構わない。実際の鍵の役目は Supabase 側の RLS が持っていて、
 * パスワードでログインしないと 1 行も読めない。
 *
 * ⚠️ service_role キーは絶対にここへ書かない。あれは RLS を素通りする鍵なので、
 *    公開した時点で誰でも全データを消せるようになる。
 *
 * ⚠️ 本当の秘密は共有アカウントの「パスワード」だけ。ここには書かない
 *    (書いたら鍵を玄関マットの下に置くのと同じ)。使う人が画面で入力する。
 */
window.CLOUD_CONFIG = {
  url: 'https://ejrhsnfagdxdqmvbdhno.supabase.co',
  anonKey: 'sb_publishable_g1H06vPo7VM2_flP65bswg_rHqtTTEb',
  email: 'kzr.0148@gmail.com',
  bucket: 'atlas',
};
