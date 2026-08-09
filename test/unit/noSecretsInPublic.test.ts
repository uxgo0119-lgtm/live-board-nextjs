// [2026-07-20新設] 「APIキーがブラウザから取得できないこと」の自動検証(要件⑤への対応)。
//
// public/ 配下は、Next.jsが static asset として"そのままの内容で"ブラウザに配信する
// ディレクトリであり、Route Handler(app/api/**)を経由しない。つまりユーザーが実際に
// 目にする・DevTools等で見られるのはこのディレクトリの中身だけ。ここに秘密鍵が
// 1バイトでも含まれていたら、それはブラウザから取得可能ということになる。
//
// このテストは今後 public/ 配下にファイルを追加・変更するたび(index.htmlの更新、
// 新しい静的ファイルの追加など)、必ずCIやデプロイ前チェックとして実行することを
// 想定している。
import fs from 'node:fs';
import path from 'node:path';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// 「本物の秘密鍵っぽい形式」を機械的に検出するパターン群。
// SUPABASE_ANON_KEYのようなpublicキー(sb_publishable_... / 従来のJWT形式anonキー)は
// ブラウザに公開される前提のものなので、意図的に検出対象から除外している。
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Anthropic APIキー(sk-ant-...)', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI APIキー(sk-...)', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'SUPABASE_SERVICE_ROLE_KEYという変数名そのもの', pattern: /SUPABASE_SERVICE_ROLE_KEY/ },
  { name: '"service_role"という文字列(Supabaseの鍵の種類を表す語)', pattern: /service_role/ },
];

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

assert(fs.existsSync(PUBLIC_DIR), 'public/ ディレクトリが存在する');

const files = listFilesRecursive(PUBLIC_DIR);
assert(files.length > 0, 'public/ 配下に少なくとも1つ以上のファイルがある(index.html等)');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = content.match(pattern);
    assert(!match, `${path.relative(PUBLIC_DIR, file)} に ${name} らしき文字列が含まれていない` + (match ? ` (検出: ${match[0].slice(0, 12)}...)` : ''));
  }
}

// SUPABASE_ANON_KEY(publishableキー)は「意図的に公開されているべき値」であることの
// ドキュメント代わりとして、少なくとも1箇所には存在することも確認しておく
// (=消えていたらSupabase連携自体が壊れているはずなので、それはそれで検知したい)。
const supabaseIntegrationPath = path.join(PUBLIC_DIR, 'supabase-integration.js');
if (fs.existsSync(supabaseIntegrationPath)) {
  const content = fs.readFileSync(supabaseIntegrationPath, 'utf8');
  assert(
    /SUPABASE_ANON_KEY\s*=\s*['"]/.test(content),
    'supabase-integration.js には(公開前提の)SUPABASE_ANON_KEYが設定されている(RLSで保護されている前提の鍵であり、これ自体は問題ない)'
  );
}

console.log('ALL PASS: noSecretsInPublic.test.ts');
