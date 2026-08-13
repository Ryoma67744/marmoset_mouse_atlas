# クラウド保存 (Supabase) の設定手順

登録データをクラウドに置いて、**どの PC で開いても同じ一覧が出る**ようにするための
一度きりの準備です。この作業をしなくてもアプリは動きます (その場合は今までどおり、
データはその PC のブラウザの中だけに保存されます)。

所要 15 分ほど。Supabase の Free プランで足ります。

---

## 0. 先に知っておいてほしいこと

| | |
|---|---|
| **パスワードは 1 つ** | 全員が同じパスワードを使い、全員が全データを読み書きできます。個人ごとの区分けはありません |
| **消したら全員から消えます** | 1 台の掃除のつもりで削除すると、他の PC からも見えなくなります |
| **後に保存したほうが勝ちます** | 同じデータを 2 台で同時に編集した場合。ただし黙って上書きはせず、必ず確認が出ます |
| **1 ファイル 50 MB まで** | Free プランの上限です。HE 画像が非常に大きいと登録時に弾かれます (§6 参照) |
| **7 日使わないと休止します** | Free プランの仕様です。ダッシュボードの **Restore** で元に戻ります。データは消えません |

---

## 1. 共有アカウントを作る

Supabase の **Authentication → Users → Add user → Create new user**

- **Email**: 自分が管理できるドメインのアドレス。例 `atlas@example.com`
  （`.local` のような届かないアドレスは避けてください。メール送信が詰まる原因になります）
- **Password**: **20 文字以上のランダムな文字列**にしてください。
  このパスワードだけが本当の鍵です。研究室で覚えやすい単語にはしないこと。
- **Auto Confirm User** に **必ずチェック**を入れる
  （入れ忘れると `email_not_confirmed` でログインできません）

作成後、そのユーザーの **UID** (`xxxxxxxx-xxxx-...` の形) を控えます。次で使います。

### 誰も新しくアカウントを作れないようにする

**Authentication → Sign In / Providers** で、次を**すべて無効**にします。

- Email の **Allow new users to sign up** を **オフ**
- **Anonymous sign-ins** を **オフ**
- Google / GitHub などの外部プロバイダを**すべてオフ**

> ここを 1 つでも有効のままにすると、誰でも自分のアカウントを作ってログインできてしまいます。
> ただし §2 の書き方 (UID を直接指定) にしておけば、仮に有効でも他人は 1 行も読めません。

---

## 2. テーブルを作る

**SQL Editor** に貼って実行します。**`<UID>` を §1 で控えた UID に置き換えてください**
(2 箇所 + §3 に 1 箇所、シングルクォートはそのまま)。

```sql
create table public.projects (
  id           text primary key,          -- アプリの proj_xxxxx をそのまま使う
  display_name text        not null default '',
  folder_path  text[]      not null default '{}',   -- フォルダ名の並び
  meta         jsonb       not null default '{}',   -- 分子名・グリッドなど一覧表示用
  state        jsonb       not null default '{}',   -- ROI・重ね合わせ・表示設定
  bundle_path  text,                                -- Storage 上の ZIP の場所
  bundle_rev   int         not null default 0,
  updated_by   text        not null default '',     -- 表示用の札 (認証ではない)
  updated_at   timestamptz not null default now()
);

-- ★ SQL Editor で作ったテーブルは RLS が「切れた」状態で始まります。
--   これを忘れると、公開されている anon キーだけで誰でも全部読めます。
alter table public.projects enable row level security;

-- 念のため、ログインしていない人の権限そのものを落としておく
revoke all on public.projects from anon;

-- ★ 「authenticated なら誰でも」ではなく、共有アカウント 1 人に限定する。
--   こうしておけば、うっかりサインアップを有効にしても他人は何も見えません。
create policy "atlas user only" on public.projects
  for all
  using      ( auth.uid() = '<UID>' )
  with check ( auth.uid() = '<UID>' );
```

---

## 3. ファイル置き場 (Storage) を作る

**Storage → New bucket**

- 名前: **`atlas`**
- **Public bucket は オフ** のまま（**重要**）

> 公開バケットにすると、URL を知っているだけで誰でも ZIP を落とせます。
> データの id は秘密ではないので、これは実質「鍵なしで公開」と同じです。

続けて **SQL Editor** で（ここも `<UID>` を置き換え）:

```sql
create policy "atlas bucket, atlas user only" on storage.objects
  for all
  using      ( bucket_id = 'atlas' and auth.uid() = '<UID>' )
  with check ( bucket_id = 'atlas' and auth.uid() = '<UID>' );
```

---

## 4. アプリに接続先を書く

**Settings → API** から次の 2 つを写します。

- **Project URL** … `https://xxxxxxxx.supabase.co`
- **anon public** キー

`lib/cloud-config.js` を開いて貼り付け、GitHub に push します。

```js
window.CLOUD_CONFIG = {
  url: 'https://xxxxxxxx.supabase.co',
  anonKey: 'eyJhbGciOi....',
  email: 'atlas@example.com',   // §1 で作ったアドレス
  bucket: 'atlas',
};
```

- **anon キーは公開して構いません。** 公開前提で設計されている鍵で、
  実際の入場制限は §2・§3 のポリシーが持っています。
  「うっかり公開してしまった」と思って隠さないでください（隠しても意味がなく、混乱の元です）。
- ⚠️ **`service_role` キーは絶対に書かないでください。** あれはポリシーを素通りする鍵で、
  公開した時点で誰でも全データを消せます。
- ⚠️ **パスワードもここに書かないでください。** 使う人が画面で入力します。

---

## 5. 動作確認

まず「鍵だけでは何も見えない」ことを確かめます。**ここが通らない場合は先に進まないでください。**

```bash
URL=https://xxxxxxxx.supabase.co
ANON=eyJhbGciOi....

# ① 鍵だけで一覧が引けないこと (行が返ってきたら §2 の RLS が効いていません)
curl -s "$URL/rest/v1/projects?select=*" -H "apikey: $ANON"

# ② 勝手にアカウントを作れないこと
curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $ANON" \
     -H 'content-type: application/json' \
     -d '{"email":"x@example.com","password":"Passw0rd!2345"}'

# ③ 正しいパスワードならログインできること (access_token が返る)
curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
     -H 'content-type: application/json' \
     -d '{"email":"atlas@example.com","password":"<パスワード>"}'
```

そのうえで、公開サイト (`https://<ユーザー名>.github.io/marmoset_mouse_atlas/`) を開いて:

1. パスワードを入れると一覧が出る
2. 小さめのデータを 1 件登録する → Supabase の **Table Editor** に行、**Storage** に ZIP ができる
3. **別の PC (または新しいブラウザのプロフィール)** で開く → 一覧に出る → `開く` で中身が落ちてくる
4. ROI を 1 つ描いて **`クラウドに保存`** → 元の PC で再読み込みすると反映されている

---

## 6. 大きい HE 画像について

Free プランは **1 ファイル 50 MB** までです。登録時の ZIP には HE 画像が
そのまま入るので、HE が大きいと `ファイルが大きすぎて送れませんでした` と出ます。

その場合はどれかで対処してください。

- HE を縮小してから登録する（表示に使う解像度は元画像ほど必要ないことが多いです）
- Supabase を Pro プランにする（上限が上がります）
- そのデータだけクラウドに置かず、この PC の中で使う（一覧では `未アップロード` のままになります）

なお、**ROI や重ね合わせの保存では ZIP を送り直しません**（数 KB の更新だけです）。
上限に当たるのは登録のときだけです。

---

## 7. パスワードを変えたいとき

**Authentication → Users → 該当ユーザー → Reset password / Update password** から変えます。
アプリ側の画面からは変えられません。変更したら、使っている全員に新しいパスワードを伝えてください。
（各 PC は次にログインし直すときから新しいパスワードが必要になります）
