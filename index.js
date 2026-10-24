// Лента мира — окно-«Reddit» для ролевого мира. Посты и комментарии пишут
// персонажи игромира интернет-сленгом. В промпт ролевой игры НЕ попадает.
// Данные: chatMetadata.worldFeed (у каждого чата своя лента).

(function () {
    'use strict';

    const EXT = 'world-feed';
    const META_KEY = 'worldFeed';
    const HI_BASE = '/scripts/extensions/third-party/hermes-images/src/';

    const DEFAULTS = {
        language: 'русский',
        historyMessages: 20,
        postsMin: 3,
        postsMax: 6,
        commentsPerPost: 3,
        maxPostChars: 500,
        maxCommentChars: 180,
        responseLength: 5000,
        extraRules: '',
        // game — стиль и внешность персонажей из последнего тега картинки в чате;
        // nopeople — без людей: пейзажи, предметы, места; custom — только свой стиль.
        imageMode: 'off',
        imageStyle: 'amateur smartphone photo, slightly blurry, casual framing, natural light',
        showFab: true,
        fabPos: null,
        // подключение: main — основное подключение чата; profile — профиль Connection Manager; custom — свой адрес/ключ
        conn: 'main',
        profileId: '',
        apiUrl: '',
        apiKey: '',
        apiModel: '',
        temperature: 1,
        systemPrompt: '',      // пусто = стандартный
        includeCard: true,
        historyMaxChars: 30000, // 0 = без лимита
    };
    const SETTINGS_VERSION = 4;

    const ctx = () => SillyTavern.getContext();

    function cfg() {
        const es = ctx().extensionSettings;
        if (!es[EXT]) es[EXT] = {};
        const s = es[EXT];
        if ((s.version || 1) < 3) s.imageMode = 'off'; // v3: фото в ленте выключены по умолчанию
        if ((s.version || 1) < 4 && s.extraRules && !s.systemPrompt) {
            // v4: «свои правила» вливаются в редактируемый системный промт
            s.systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n- Дополнительно: ${s.extraRules}`;
            s.extraRules = '';
        }
        if ((s.version || 1) < 2) {
            // v1 → v2: больше постов, меньше комментов, лимиты длины.
            Object.assign(s, { postsMin: 3, postsMax: 6, commentsPerPost: 3, responseLength: 5000 });
        }
        s.version = SETTINGS_VERSION;
        for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
        return s;
    }

    function feed() {
        const md = ctx().chatMetadata;
        if (!md) return null;
        if (!md[META_KEY] || !Array.isArray(md[META_KEY].posts)) md[META_KEY] = { posts: [] };
        return md[META_KEY];
    }

    const save = () => ctx().saveMetadataDebounced();
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    // ---------- текст ----------

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** Мини-markdown поверх экранированного текста: **жирный**, *курсив*, ~~зачёрк~~, >цитата, >!спойлер!<. */
    function md(s) {
        let h = esc(s);
        h = h.replace(/&gt;!(.+?)!&lt;/g, '<span class="wf-spoiler" title="спойлер">$1</span>');
        h = h.split('\n').map(line => /^&gt;\s?/.test(line)
            ? `<blockquote>${line.replace(/^&gt;\s?/, '')}</blockquote>` : line).join('\n');
        h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
            .replace(/~~(.+?)~~/g, '<s>$1</s>')
            .replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>')
            .replace(/<\/blockquote><br>/g, '</blockquote>');
        return h;
    }

    function ago(ts) {
        const m = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 60000));
        if (m < 1) return 'только что';
        if (m < 60) return `${m} мин. назад`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} ч. назад`;
        return `${Math.round(h / 24)} дн. назад`;
    }

    function fmtScore(n) {
        n = Number(n) || 0;
        return Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(n);
    }

    function avatarColor(name) {
        let h = 0;
        for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return `hsl(${h} 55% 45%)`;
    }

    const normUser = a => (String(a || 'anon').trim().replace(/^\/?u\//i, '') || 'anon');
    const normSub = s => (String(s || 'world').trim().replace(/^\/?r\//i, '').replace(/\s+/g, '_') || 'world');

    // ---------- контекст для модели ----------

    function stripHtml(s) {
        return String(s || '').replace(/<img[^>]*>/gi, '[картинка]').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function worldContext() {
        const c = ctx();
        const parts = [];
        let card = {};
        try { card = c.getCharacterCardFields?.() || {}; } catch { /* группа без карточки */ }
        const sub = t => (c.substituteParams ? c.substituteParams(t) : t);
        if (c.groupId) {
            const g = c.groups?.find(x => x.id === c.groupId);
            const names = (g?.members || []).map(av => c.characters.find(ch => ch.avatar === av)?.name).filter(Boolean);
            if (names.length) parts.push(`Участники группового чата: ${names.join(', ')}`);
        }
        if (cfg().includeCard === false) card = {};
        if (card.description) parts.push(`## Персонаж/мир (${c.name2})\n${sub(card.description)}`);
        if (card.personality) parts.push(`## Характер\n${sub(card.personality)}`);
        if (card.scenario) parts.push(`## Сценарий\n${sub(card.scenario)}`);
        if (card.persona) parts.push(`## Персона игрока (${c.name1})\n${sub(card.persona)}`);

        const n = Math.max(1, Number(cfg().historyMessages) || 20);
        const budget = Math.max(0, Number(cfg().historyMaxChars) || 0);
        const all = (c.chat || []).filter(m => !m.is_system && m.mes).slice(-n)
            .map(m => `${m.is_user ? c.name1 : (m.name || c.name2)}: ${stripHtml(m.mes)}`);
        // С конца (свежее важнее), пока влезает в лимит символов.
        const hist = [];
        let used = 0;
        for (let i = all.length - 1; i >= 0; i--) {
            const t = all[i];
            if (budget && used + t.length > budget) {
                if (!hist.length) hist.unshift('…' + t.slice(-budget)); // одно огромное сообщение — берём хвост
                break;
            }
            hist.unshift(t); used += t.length;
        }
        if (hist.length) parts.push(`## Последние события ролевой игры\n${hist.join('\n\n')}`);
        return parts.join('\n\n');
    }

    function styleRules() {
        const s = cfg();
        const c = ctx();
        const tpl = String(s.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
        return tpl.replace(/\{\{language\}\}/gi, s.language || 'русский')
            .replace(/\{\{user\}\}/gi, c.name1 || 'User')
            .replace(/\{\{char\}\}/gi, c.name2 || '');
    }

    const DEFAULT_SYSTEM_PROMPT = `Ты — генератор ленты вымышленной соцсети в стиле Reddit, которая существует ВНУТРИ мира ролевой игры. Главный юмор: даже если в сеттинге нет интернета (средневековье, эльфы, древность, космос), персонажи этого мира всё равно сидят на «Реддите» и пишут как типичные пользователи 2010–2020-х.

Правила:
- Авторы постов и комментариев — персонажи этого мира: канонические герои, второстепенные лица, безымянные жители, стражники, торговцы, тролли из комментов. Ники — внутримировые и смешные (пример стиля: u/Silmaril_Enjoyer, u/not_a_balrog_tbh, u/sons_of_feanor_official).
- Сабреддиты — внутримировые (r/Beleriand, r/AmItheOrc, r/ElvesWithProblems, r/MildlyInfuriatingMorgoth и т.п., придумай под текущий мир).
- Речь: интернет-сленг, эмодзи, мемные форматы (AITA, TIL, ELI5, «просто оставлю это здесь», «это база», «ну всё, началось», copypasta, «edit: спасибо за золото, незнакомец»), опечатки и капслок уместны. Срачи, поддакивание, душнилы, мем-ответы, споры о каноне.
- Персонажи сохраняют СВОИ характеры и знания: гордый остаётся гордым, но в формате коммента. Отсылки к реальным событиям последних сообщений ролевой игры обязательны — лента реагирует на то, что произошло (слухи, сплетни, искажения, хайп).
- Не пересказывай чат: комментаторы знают о событиях из слухов, могут ошибаться и спорить.
- Язык текста: {{language}}. Ники и названия сабов — латиницей.
- Персонаж игрока ({{user}}) может упоминаться в третьем лице, но не пишет сам.`;

    const COMMENT_SCHEMA = `{"author":"ник","flair":"короткий флер или пусто","body":"текст","score":число,"replies":[ ...такие же объекты, вложенность до 2 уровней... ]}`;

    // ---------- картинки из игры ----------

    function decodeEntities(s) {
        return String(s).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }

    function looseField(raw, key) {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
        if (!m) return '';
        try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
    }

    /** Разбирает data-iig-instruction='{...}' из текста сообщения. */
    function instructionsIn(text) {
        const out = [];
        const re = /data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1(?=[\s>\/])/gi;
        let m;
        while ((m = re.exec(String(text || ''))) !== null) {
            const raw = decodeEntities(m[2]);
            let o = null;
            try { o = JSON.parse(raw); } catch { o = { style: looseField(raw, 'style'), prompt: looseField(raw, 'prompt') }; }
            if (o && (o.style || o.prompt)) out.push({ style: String(o.style || ''), prompt: String(o.prompt || '') });
        }
        return out;
    }

    // Состояние сцены, которое не должно переезжать в «фото из соцсети».
    const SCENE_STATE_RE = /\b(shirtless|bare[- ]?chested|topless|naked|nude|undress(?:ed|ing)?|bare (?:skin|torso|chest|shoulders|back)|towel[- ]clad|wet (?:skin|body)|damp|muscular|muscles?|abs|six[- ]pack|toned (?:body|physique)|athletic (?:build|body)|sweaty|bathing|in the bath)\b/gi;

    function scrub(s) {
        return String(s || '').replace(SCENE_STATE_RE, '').replace(/\(\s*,|,\s*\)/g, m => m.includes('(') ? '(' : ')')
            .replace(/,\s*(?:,\s*)+/g, ', ').replace(/\s{2,}/g, ' ').trim();
    }

    // Позы и действия из конкретной сцены («прижался к плечу», «лежит на скамье»).
    const POSE_RE = /\b(resting|lying|laying|sitting|seated|standing|holding|leaning|looking|staring|gazing|tucked|wrapped|kissing|hugging|embracing|cuddling|pressed|pressing|against|draped|smiling|crying|sleeping|reaching|touching|clutching|kneeling|walking|turned|facing)\b/i;

    function stripPoses(text) {
        // Внутри скобок каждого персонажа — список через запятую; выкидываем пункты-действия.
        return String(text).replace(/\(([^()]*)\)/g, (_, inner) =>
            '(' + inner.split(',').map(x => x.trim()).filter(x => x && !POSE_RE.test(x)).join(', ') + ')')
            .replace(/[.\s]+$/, '');
    }

    /** Стиль и внешность персонажей из последних тегов картинок в чате. */
    function gameImageInfo() {
        const chat = ctx().chat || [];
        let style = '', chars = '';
        for (let i = chat.length - 1; i >= 0 && (!style || !chars); i--) {
            const list = instructionsIn(chat[i]?.mes);
            for (let j = list.length - 1; j >= 0; j--) {
                if (!style && list[j].style) style = list[j].style;
                if (!chars) {
                    const m = list[j].prompt.match(/Characters?\s*:\s*([\s\S]*?)(?=\b(?:Lighting|Location|Background(?: elements)?|Panels?(?:\s*\d)?|Composition|Camera|Mood|Atmosphere|Action|Scene)\s*:|ABSOLUTELY|$)/i);
                    if (m && m[1].trim()) chars = stripPoses(m[1].trim());
                }
            }
        }
        return { style: scrub(style).slice(0, 900), chars: scrub(chars).slice(0, 1800) };
    }

    function imageGuidance() {
        const s = cfg();
        if (s.imageMode === 'off') return 'Поле image_prompt всегда пустая строка: картинок нет, пост-«фото» описывай словами в тексте.';
        const base = 'Поле image_prompt: примерно у половины постов — фото/мем/скриншот к посту, описание кадра НА АНГЛИЙСКОМ, 1–3 предложения, без надписей и текста на картинке; у остальных пустая строка.';
        if (s.imageMode === 'nopeople') {
            return `${base} ВАЖНО: на кадре НЕТ людей вообще — только места, предметы, животные, последствия событий (сгоревшие корабли, разбитая кружка, флаг на стене, еда, документ, вид из окна). Можно «рука в кадре держит предмет», не больше.`;
        }
        if (s.imageMode === 'game') {
            const g = gameImageInfo();
            if (g.chars) {
                return `${base} Если в кадре персонаж ролевой игры — бери его ВНЕШНОСТЬ (волосы, лицо, шрамы, особые приметы) из описания ниже дословно, но одежду и позу выбирай по ситуации поста: люди полностью одеты, обычное телосложение, никакого фансервиса. Кадры без людей тоже хороши.
Внешность персонажей из игры:
${g.chars}`;
            }
        }
        return `${base} Без фансервиса: люди полностью одеты по ситуации, обычное телосложение.`;
    }

    function postsPrompt() {
        const s = cfg();
        const f = feed();
        const recent = f.posts.slice(0, 12).map(p => `- r/${p.sub}: ${p.title}`).join('\n');
        const min = Math.max(1, Number(s.postsMin) || 1), max = Math.max(min, Number(s.postsMax) || 3);
        return `${worldContext()}

${recent ? `## Уже опубликовано (не повторяй темы)\n${recent}\n\n` : ''}## Задание
Сгенерируй от ${min} до ${max} новых постов ленты по свежим событиям ролевой игры. Посты разные по формату: короткие мемы, вопросы, AITA, новости-слухи, жалобы, фото с подписью.
У каждого поста ${s.commentsPerPost} комментариев верхнего уровня, ответы на них — редко и коротко.
ДЛИНА СТРОГО: текст поста не длиннее ${s.maxPostChars} символов (лучше короче, многие посты — 1–2 строки или только заголовок), каждый комментарий не длиннее ${s.maxCommentChars} символов. Это соцсеть, а не летопись: никаких полотен, списков на десять пунктов и пересказов.
${imageGuidance()}

Ответь ТОЛЬКО JSON без пояснений:
{"posts":[{"sub":"название сабреддита","author":"ник","flair":"флер поста или пусто","title":"заголовок","body":"текст поста (может быть пустым, если пост-картинка)","image_prompt":"...","score":число,"comments":[${COMMENT_SCHEMA}]}]}`;
    }

    function threadToText(list, depth = 0) {
        return (list || []).map(c => `${'  '.repeat(depth)}- u/${c.author}: ${c.body}\n${threadToText(c.replies, depth + 1)}`).join('');
    }

    function morePrompt(post) {
        return `${worldContext()}

## Пост
r/${post.sub} · u/${post.author}
${post.title}
${post.body || ''}

## Комментарии сейчас
${threadToText(post.comments) || '(пока нет)'}

## Задание
Добавь ещё ${cfg().commentsPerPost} комментариев (каждый не длиннее ${cfg().maxCommentChars} символов): новые люди заходят в тред, отвечают на существующие комменты (особенно на комменты u/${ctx().name1}, если есть — ответь каждому), разгоняют срач или мем.
Ответь ТОЛЬКО JSON:
{"new":[${COMMENT_SCHEMA}],"replies":[{"to":"точный ник автора, которому отвечают","to_text":"первые слова его коммента","comment":${COMMENT_SCHEMA}}]}`;
    }

    // ---------- вызов модели ----------

    function parseJson(raw) {
        let t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) t = fence[1];
        const a = t.indexOf('{'), b = t.lastIndexOf('}');
        if (a < 0 || b <= a) throw new Error('модель не вернула JSON');
        t = t.slice(a, b + 1);
        try { return JSON.parse(t); }
        catch { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); }
    }

    function errText(e) {
        const out = [];
        const seen = new Set();
        for (let x = e, i = 0; x && i < 5 && !seen.has(x); x = x.cause, i++) {
            seen.add(x);
            out.push(x.message || String(x));
            if (x.status) out.push(`HTTP ${x.status}`);
        }
        return out.join(' ← ') || 'неизвестная ошибка';
    }

    function joinApi(base, path) {
        let b = String(base || '').trim().replace(/\/+$/, '');
        if (b && !/^https?:\/\//i.test(b)) b = 'https://' + b; // без схемы fetch уйдёт на сам ST
        return b.replace(/\/chat\/completions$/i, '') + path;
    }

    function contentText(c) {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : x?.text || '')).join('');
        return '';
    }

    /**
     * Свой адрес/ключ. Запрос идёт через сервер ST (как обычный Custom-источник),
     * поэтому CORS прокси не мешает. Ключ передаётся заголовком custom_include_headers,
     * который сервер ставит ПОСЛЕ своего Authorization, — сохранённые секреты ST не трогаются.
     */
    async function customCall(system, user, maxTokens) {
        const s = cfg();
        const c = ctx();
        if (!s.apiUrl) throw new Error('не указан адрес API (Настройки ленты → Подключение)');
        if (!s.apiModel) throw new Error('не указана модель (Настройки ленты → Подключение)');
        const payload = {
            stream: false,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            model: s.apiModel,
            chat_completion_source: 'custom',
            custom_url: joinApi(s.apiUrl, ''),
            max_tokens: maxTokens,
            temperature: Number.isFinite(+s.temperature) ? +s.temperature : 1,
        };
        if (s.apiKey) payload.custom_include_headers = JSON.stringify({ Authorization: `Bearer ${String(s.apiKey).trim()}` });
        const r = await c.ChatCompletionService.processRequest(payload, {}, true);
        const out = typeof r === 'string' ? r : contentText(r?.content);
        if (!out) throw new Error('прокси вернул пустой ответ');
        return out;
    }

    /** Сырой текст ответа модели по выбранному подключению. */
    async function callModel(system, user, maxTokens) {
        const s = cfg();
        const c = ctx();
        if (s.conn === 'custom') return customCall(system, user, maxTokens);
        if (s.conn === 'profile') {
            if (!s.profileId) throw new Error('не выбран профиль подключения (Настройки ленты → Подключение)');
            const prof = c.extensionSettings.connectionManager?.profiles?.find(p => p.id === s.profileId);
            if (!prof) throw new Error('выбранный профиль подключения удалён — выбери другой');
            const r = await c.ConnectionManagerRequestService.sendRequest(s.profileId,
                [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens,
                { stream: false, extractData: true, includePreset: false, includeInstruct: false });
            return typeof r === 'string' ? r : contentText(r?.content);
        }
        return c.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
    }

    async function ask(prompt) {
        const raw = await callModel(styleRules(), prompt, Number(cfg().responseLength) || 5000);
        return parseJson(raw);
    }

    function connLabel() {
        const s = cfg();
        if (s.conn === 'custom') { try { return `${new URL(joinApi(s.apiUrl, '')).host} · ${s.apiModel || '?'}`; } catch { return 'свой API (адрес не задан)'; } }
        if (s.conn === 'profile') {
            const p = ctx().extensionSettings.connectionManager?.profiles?.find(x => x.id === s.profileId);
            return p ? `профиль «${p.name}»` : 'профиль не выбран';
        }
        return 'основное подключение чата';
    }

    /** Жёсткая страховка от полотен: модель получает лимит в промпте, а тут режем то, что вылезло сильно за него. */
    function cap(text, limit) {
        const s = String(text || '').trim();
        const max = Math.round((Number(limit) || 0) * 1.3);
        if (!max || s.length <= max) return s;
        const cut = s.slice(0, max);
        const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
        return (at > max * 0.6 ? cut.slice(0, at + 1) : cut.replace(/\s+\S*$/, '')) + '…';
    }

    function normComment(c) {
        if (!c || typeof c !== 'object') return null;
        const body = cap(c.body ?? c.text ?? '', cfg().maxCommentChars);
        if (!body) return null;
        return {
            id: uid(),
            author: normUser(c.author),
            flair: String(c.flair || '').slice(0, 40),
            body,
            score: Number.isFinite(+c.score) ? Math.round(+c.score) : Math.floor(Math.random() * 300),
            ts: Date.now() - Math.floor(Math.random() * 3 * 3600e3),
            replies: (Array.isArray(c.replies) ? c.replies : []).map(normComment).filter(Boolean),
        };
    }

    function normPost(p) {
        if (!p || !String(p.title || '').trim()) return null;
        return {
            id: uid(),
            sub: normSub(p.sub),
            author: normUser(p.author),
            flair: String(p.flair || '').slice(0, 40),
            title: String(p.title).trim(),
            body: cap(p.body, cfg().maxPostChars),
            score: Number.isFinite(+p.score) ? Math.round(+p.score) : Math.floor(Math.random() * 5000),
            ts: Date.now(),
            vote: 0,
            image: p.image_prompt && cfg().imageMode !== 'off' ? { prompt: String(p.image_prompt).trim(), src: '' } : null,
            comments: (Array.isArray(p.comments) ? p.comments : []).map(normComment).filter(Boolean),
        };
    }

    let busy = false;

    async function refreshFeed() {
        if (busy) return;
        const chatId = ctx().getCurrentChatId?.();
        if (!chatId) return toastr.info('Сначала открой чат.', 'Лента мира');
        busy = true; renderBusy();
        try {
            const data = await ask(postsPrompt());
            if (ctx().getCurrentChatId?.() !== chatId) return;
            const posts = (Array.isArray(data) ? data : data.posts || []).map(normPost).filter(Boolean);
            if (!posts.length) throw new Error('в ответе нет постов');
            feed().posts.unshift(...posts);
            save();
            if (!isOpen) setBadge(posts.length);
            toastr.success(`Новых постов: ${posts.length}`, 'Лента мира');
        } catch (e) {
            console.error('[world-feed]', e);
            toastr.error(errText(e), 'Лента не обновилась', { timeOut: 10000 });
        } finally {
            busy = false; render();
        }
    }

    function findComment(list, author, text) {
        const a = normUser(author).toLowerCase();
        const t = String(text || '').toLowerCase().slice(0, 25);
        let fallback = null;
        const walk = l => {
            for (const c of l || []) {
                if (c.author.toLowerCase() === a) {
                    if (!t || c.body.toLowerCase().startsWith(t.slice(0, 12))) return c;
                    fallback ??= c;
                }
                const r = walk(c.replies);
                if (r) return r;
            }
            return null;
        };
        return walk(list) || fallback;
    }

    const postBusy = new Set();

    async function moreComments(postId) {
        const chatId = ctx().getCurrentChatId?.();
        const post = feed()?.posts.find(p => p.id === postId);
        if (!post || postBusy.has(postId)) return;
        postBusy.add(postId); render();
        try {
            const data = await ask(morePrompt(post));
            if (ctx().getCurrentChatId?.() !== chatId) return;
            let added = 0;
            for (const r of data.replies || []) {
                const cm = normComment(r.comment);
                if (!cm) continue;
                const target = findComment(post.comments, r.to, r.to_text);
                (target ? target.replies : post.comments).push(cm);
                added++;
            }
            for (const n of data.new || []) {
                const cm = normComment(n);
                if (cm) { post.comments.push(cm); added++; }
            }
            save();
            if (!added) toastr.info('Модель ничего не добавила.', 'Лента мира');
        } catch (e) {
            console.error('[world-feed]', e);
            toastr.error(errText(e), 'Комментарии не загрузились', { timeOut: 10000 });
        } finally {
            postBusy.delete(postId); render();
        }
    }

    // ---------- картинки через hermes-images ----------

    async function uploadImage(dataUrl) {
        const c = ctx();
        const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) throw new Error('картинка пришла не в base64');
        let format = m[1].toLowerCase().replace('jpeg', 'jpg');
        if (!['png', 'jpg', 'webp', 'gif'].includes(format)) format = 'png';
        const resp = await fetch('/api/images/upload', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ image: m[2], format, ch_name: 'world-feed', filename: `wf_${uid()}` }),
        });
        if (!resp.ok) throw new Error(`ST не сохранил файл: HTTP ${resp.status} ${await resp.text().catch(() => '')}`.trim());
        const j = await resp.json();
        return j.path.startsWith('/') ? j.path : `/${j.path}`;
    }

    const DRESSED = 'Everyone in the shot is fully and appropriately dressed for the situation, ordinary everyday bodies; no shirtless or bare-chested people, no fitness-model or bodybuilder physiques, no fanservice.';
    const NO_TEXT = 'No text, captions, UI, logos or watermarks.';

    /** Итоговый промт для фото поста в зависимости от режима. */
    function buildImagePrompt(scene, hcfg) {
        const s = cfg();
        const parts = [];
        let useRefs = false;
        if (s.imageMode === 'nopeople') {
            if (s.imageStyle) parts.push(`Style: ${s.imageStyle}`);
            parts.push(scene);
            parts.push('NO people, no humans, no faces, no bodies in the frame — only the place, objects, animals or aftermath. ' + NO_TEXT);
        } else if (s.imageMode === 'game') {
            const g = gameImageInfo();
            const style = g.style || s.imageStyle;
            if (style) parts.push(`Style: ${style}`);
            parts.push(`Single image (not a comic page, no panels) posted to a social feed. ${scene}`);
            if (g.chars) parts.push(`Appearance reference — use ONLY for characters who are actually in this shot, keep their faces, hair and distinctive marks exactly, ignore any clothing state from it:\n${g.chars}`);
            parts.push(DRESSED + ' ' + NO_TEXT);
            useRefs = true;
        } else {
            if (s.imageStyle) parts.push(`Style: ${s.imageStyle}`);
            parts.push(scene);
            parts.push(DRESSED + ' ' + NO_TEXT);
        }
        let prompt = parts.join('\n\n');
        const max = Number(hcfg?.maxPromptChars) || 3900;
        if (prompt.length > max) {
            // Режем справку о внешности, а не сцену и запреты.
            const over = prompt.length - max;
            const i = parts.findIndex(x => x.startsWith('Appearance reference'));
            if (i >= 0) parts[i] = parts[i].slice(0, Math.max(200, parts[i].length - over - 1));
            prompt = parts.join('\n\n').slice(0, max);
        }
        return { prompt, useRefs };
    }

    async function genImage(postId) {
        const post = feed()?.posts.find(p => p.id === postId);
        if (!post) return;
        if (!post.image) post.image = { prompt: '', src: '' };
        if (!post.image.prompt) {
            const p = await ctx().Popup.show.input('Фото к посту', 'Что на снимке? (лучше по-английски)', post.title);
            if (!p) return;
            post.image.prompt = p;
        }
        if (post.image.busy) return;
        let prov, settings;
        try {
            prov = await import(HI_BASE + 'provider.js');
            settings = await import(HI_BASE + 'settings.js');
        } catch (e) {
            return toastr.error('Нужно расширение Hermes Images — оно рисует картинки. ' + errText(e), 'Лента мира');
        }
        post.image.busy = true; post.image.error = ''; render();
        try {
            const hcfg = settings.getCfg();
            const { prompt, useRefs } = buildImagePrompt(post.image.prompt, hcfg);
            let refs = [];
            if (useRefs) {
                try { refs = await (await import(HI_BASE + 'refs.js')).collectRefs(hcfg); }
                catch (e) { console.warn('[world-feed] refs', e); }
            }
            const dataUrl = await prov.generateImage({ prompt, aspect: '4:3', refs, cfg: hcfg });
            post.image.src = await uploadImage(dataUrl);
            save();
        } catch (e) {
            console.error('[world-feed] image', e);
            const t = prov.describeError ? prov.describeError(e) : errText(e);
            post.image.error = t;
            toastr.error(t, 'Фото не сгенерировалось', { timeOut: 10000 });
        } finally {
            delete post.image.busy; save(); render();
        }
    }

    // ---------- окно ----------

    let $win = null;
    let isOpen = false;
    const ui = { open: new Set(), expanded: new Set(), sub: '', sort: 'new' };
    const LONG_POST = 320;

    function ensureWindow() {
        if ($win) return $win;
        $win = $(`
<div id="wf_window" class="wf-root" style="display:none">
  <div class="wf-browser">
    <div class="wf-chrome">
      <span class="wf-dots"><i></i><i></i><i></i></span>
      <span class="wf-url">https://www.reddit.world/<span id="wf_url_sub"></span></span>
      <span class="wf-close" title="Закрыть">✕</span>
    </div>
    <div class="wf-topbar">
      <span class="wf-logo"><span class="wf-snoo">👽</span> <b>reddit</b><small>.world</small></span>
      <span class="wf-sort">
        <button data-sort="new">🆕 Новое</button><button data-sort="hot">🔥 Горячее</button><button data-sort="top">🏆 Топ</button>
      </span>
      <button class="wf-refresh">⟳ Обновить ленту</button>
      <button class="wf-gear" title="Настройки ленты">⚙ Настройки</button>
    </div>
    <div class="wf-body">
      <div class="wf-feed"></div>
      <aside class="wf-side"></aside>
    </div>
    <div class="wf-settings-page" style="display:none"></div>
  </div>
</div>`);
        $('body').append($win);

        $win.on('click', '.wf-close', close);
        $win.on('click', function (e) { if (e.target === this) close(); });
        $win.on('click', '.wf-refresh', refreshFeed);
        $win.on('click', '.wf-gear', () => toggleSettings());
        bindSettingsPage($win.find('.wf-settings-page'));
        $win.on('click', '[data-sort]', function () { ui.sort = this.dataset.sort; render(); });
        $win.on('click', '[data-sub]', function () { ui.sub = this.dataset.sub; render(); $win.find('.wf-feed').scrollTop(0); });
        $win.on('click', '.wf-spoiler', function () { $(this).toggleClass('wf-shown'); });
        $win.on('click', '[data-act]', onAction);
        $win.on('keydown', '.wf-reply-input', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $(this).siblings('[data-act="send"]').trigger('click');
        });
        $(document).on('keydown.wf', e => {
            if (e.key !== 'Escape' || !isOpen) return;
            if (settingsOpen) toggleSettings(false); else close();
        });
        return $win;
    }

    function open() { isOpen = true; setBadge(0); ensureWindow().fadeIn(120); render(); }
    function close() { isOpen = false; $win?.fadeOut(120); }

    function sorted(posts) {
        const arr = posts.filter(p => !ui.sub || p.sub === ui.sub);
        if (ui.sort === 'top') return arr.sort((a, b) => (b.score + b.vote) - (a.score + a.vote));
        if (ui.sort === 'hot') return arr.sort((a, b) => (b.score + b.comments.length * 50) / Math.pow((Date.now() - b.ts) / 3600e3 + 2, 1.5)
            - (a.score + a.comments.length * 50) / Math.pow((Date.now() - a.ts) / 3600e3 + 2, 1.5));
        return arr.sort((a, b) => b.ts - a.ts);
    }

    const countComments = l => (l || []).reduce((n, c) => n + 1 + countComments(c.replies), 0);

    function voteBox(score, vote, path) {
        return `<div class="wf-vote ${vote > 0 ? 'up' : vote < 0 ? 'down' : ''}">
<button data-act="up" data-path="${path}" title="Плюс">▲</button><span>${fmtScore((score || 0) + (vote || 0))}</span><button data-act="down" data-path="${path}" title="Минус">▼</button></div>`;
    }

    function commentHtml(c, postId, depth) {
        const isUser = c.mine;
        return `<div class="wf-comment" data-cid="${c.id}">
<div class="wf-c-line" title="Свернуть" data-act="collapse" data-path="${postId}|${c.id}"></div>
<div class="wf-c-main ${c.collapsed ? 'wf-collapsed' : ''}">
  <div class="wf-c-head"><span class="wf-ava" style="background:${avatarColor(c.author)}">${esc(c.author[0] || '?').toUpperCase()}</span>
    <b class="${isUser ? 'wf-me' : ''}">u/${esc(c.author)}</b>${c.flair ? `<span class="wf-flair">${esc(c.flair)}</span>` : ''}
    <span class="wf-muted">· ${ago(c.ts)}</span>${c.collapsed ? `<span class="wf-muted"> [+${countComments(c.replies) + 1}]</span>` : ''}</div>
  ${c.collapsed ? '' : `<div class="wf-c-body">${md(c.body)}</div>
  <div class="wf-c-actions">${voteBox(c.score, c.vote, `${postId}|${c.id}`)}
    <button data-act="reply" data-path="${postId}|${c.id}">💬 Ответить</button>
    <button data-act="delc" data-path="${postId}|${c.id}" title="Удалить коммент">🗑</button></div>
  <div class="wf-reply-slot"></div>
  ${(c.replies || []).map(r => commentHtml(r, postId, depth + 1)).join('')}`}
</div></div>`;
    }

    function imageHtml(p) {
        if (!p.image) return '';
        if (cfg().imageMode === 'off' && !p.image.src) return '';
        if (p.image.src) return `<div class="wf-img"><img src="${esc(p.image.src)}" data-act="zoom" data-path="${p.id}" loading="lazy" alt=""></div>`;
        if (p.image.busy) return `<div class="wf-img wf-img-ph"><span class="wf-spin"></span> фото грузится…</div>`;
        return `<div class="wf-img wf-img-ph" data-act="img" data-path="${p.id}" title="${esc(p.image.prompt)}">
  📷 <b>Тут было фото</b><br><small>${esc(p.image.prompt).slice(0, 160)}</small><br>${p.image.error ? `<small class="wf-err">${esc(p.image.error)}</small><br>` : ''}<u>нажми, чтобы сгенерировать</u></div>`;
    }

    function postHtml(p) {
        const isOpen = ui.open.has(p.id);
        const isLong = (p.body || '').length > LONG_POST || (p.body || '').split('\n').length > 6;
        const expanded = !isLong || ui.expanded.has(p.id) || isOpen;
        const n = countComments(p.comments);
        return `<article class="wf-post" data-pid="${p.id}">
${voteBox(p.score, p.vote, p.id)}
<div class="wf-p-main">
  <div class="wf-p-head"><span class="wf-subicon" style="background:${avatarColor(p.sub)}">r/</span>
    <b data-sub="${esc(p.sub)}" class="wf-link">r/${esc(p.sub)}</b>
    <span class="wf-muted">· Опубликовал u/${esc(p.author)} · ${ago(p.ts)}</span></div>
  <h3 class="wf-title">${esc(p.title)}${p.flair ? ` <span class="wf-pflair">${esc(p.flair)}</span>` : ''}</h3>
  ${p.body ? `<div class="wf-p-body ${expanded ? '' : 'wf-clamp'}">${md(p.body)}</div>` : ''}
  ${isLong ? `<button class="wf-expand" data-act="expand" data-path="${p.id}">${expanded ? '▲ Свернуть пост' : '▼ Читать полностью'}</button>` : ''}
  ${imageHtml(p)}
  <div class="wf-p-actions">
    <button data-act="toggle" data-path="${p.id}">💬 ${n} коммент.</button>
    <button data-act="award" data-path="${p.id}">🏅 Наградить${p.awards ? ` (${p.awards})` : ''}</button>
    ${p.image || cfg().imageMode === 'off' ? '' : `<button data-act="img" data-path="${p.id}">📷 Фото</button>`}
    ${p.image?.src ? `<button data-act="reimg" data-path="${p.id}">🔄 Другое фото</button>` : ''}
    <button data-act="delp" data-path="${p.id}">🗑 Удалить</button>
  </div>
  ${isOpen ? `<div class="wf-thread">
    <div class="wf-composer"><textarea class="wf-reply-input" data-path="${p.id}" placeholder="Что думаешь, u/${esc(normUser(ctx().name1))}? (Ctrl+Enter — отправить)"></textarea>
      <button data-act="send" data-path="${p.id}">Комментировать</button></div>
    ${p.comments.map(c => commentHtml(c, p.id, 0)).join('') || '<div class="wf-muted wf-pad">Тут пока тихо…</div>'}
    <button class="wf-more" data-act="more" data-path="${p.id}" ${postBusy.has(p.id) ? 'disabled' : ''}>${postBusy.has(p.id) ? '<span class="wf-spin"></span> люди печатают…' : '⬇ Загрузить ещё комментарии'}</button>
  </div>` : ''}
</div></article>`;
    }

    function sideHtml(posts) {
        const subs = {};
        for (const p of posts) subs[p.sub] = (subs[p.sub] || 0) + 1;
        const list = Object.entries(subs).sort((a, b) => b[1] - a[1]);
        return `<div class="wf-card"><div class="wf-card-h">Сообщества мира</div>
<div class="wf-sub-item ${ui.sub ? '' : 'on'}" data-sub="">🏠 Вся лента <span class="wf-muted">${posts.length}</span></div>
${list.map(([s, n]) => `<div class="wf-sub-item ${ui.sub === s ? 'on' : ''}" data-sub="${esc(s)}"><span class="wf-subicon sm" style="background:${avatarColor(s)}">r/</span>${esc(s)} <span class="wf-muted">${n}</span></div>`).join('')}
</div>
<div class="wf-card wf-pad wf-muted">🔌 ${esc(connLabel())}<br><button class="wf-linkbtn wf-blue" data-act="settings">⚙ Настройки ленты</button></div>
<div class="wf-card wf-muted wf-pad">Лента — чистое развлечение: в промпт ролевой игры не попадает. Хранится в этом чате.
<br><br><button class="wf-linkbtn" data-act="clear">Очистить ленту чата</button></div>`;
    }

    function renderBusy() {
        if (!$win) return;
        $win.find('.wf-refresh').prop('disabled', busy).html(busy ? '<span class="wf-spin"></span> Мир пишет посты…' : '⟳ Обновить ленту');
    }

    function render() {
        if (!$win || !isOpen) return;
        const f = feed();
        const $feed = $win.find('.wf-feed');
        const scroll = $feed.scrollTop();
        const drafts = {};
        $win.find('.wf-reply-input').each(function () { if (this.value) drafts[this.dataset.path] = this.value; });
        $win.find('#wf_url_sub').text(ui.sub ? `r/${ui.sub}/` : '');
        $win.find('[data-sort]').each(function () { $(this).toggleClass('on', this.dataset.sort === ui.sort); });
        renderBusy();
        if (!f) {
            $feed.html('<div class="wf-empty">Открой чат — у каждого чата своя лента.</div>');
            $win.find('.wf-side').empty();
            return;
        }
        const posts = sorted(f.posts);
        $feed.html(posts.length ? posts.map(postHtml).join('')
            : `<div class="wf-empty">👽<br>Здесь пока пусто.<br>Нажми «Обновить ленту» — и жители мира начнут обсуждать, что у вас стряслось.</div>`);
        $win.find('.wf-side').html(sideHtml(f.posts));
        $win.find('.wf-reply-input').each(function () { if (drafts[this.dataset.path]) this.value = drafts[this.dataset.path]; });
        $feed.scrollTop(scroll);
    }

    function locate(path) {
        const [pid, cid] = String(path).split('|');
        const post = feed()?.posts.find(p => p.id === pid);
        if (!post || !cid) return { post };
        let found = null, parent = null;
        const walk = (l, par) => {
            for (const c of l) {
                if (c.id === cid) { found = c; parent = par; return true; }
                if (walk(c.replies || [], c)) return true;
            }
            return false;
        };
        walk(post.comments, null);
        return { post, comment: found, parentList: parent ? parent.replies : post.comments };
    }

    async function onAction(e) {
        e.stopPropagation();
        const act = this.dataset.act;
        const path = this.dataset.path;
        const { post, comment, parentList } = locate(path || '');
        const target = comment || post;
        switch (act) {
            case 'up': case 'down': {
                if (!target) return;
                const v = act === 'up' ? 1 : -1;
                target.vote = target.vote === v ? 0 : v;
                break;
            }
            case 'toggle': ui.open.has(post.id) ? ui.open.delete(post.id) : ui.open.add(post.id); break;
            case 'expand':
                if (ui.expanded.has(post.id) || ui.open.has(post.id)) { ui.expanded.delete(post.id); ui.open.delete(post.id); }
                else ui.expanded.add(post.id);
                break;
            case 'collapse': if (comment) comment.collapsed = !comment.collapsed; break;
            case 'award':
                post.awards = (post.awards || 0) + 1;
                toastr.info('edit: спасибо за награду, добрый незнакомец 🏅', `u/${post.author}`);
                break;
            case 'img': return genImage(post.id);
            case 'reimg': post.image.src = ''; return genImage(post.id);
            case 'zoom': window.open(post.image.src, '_blank'); return;
            case 'more': return moreComments(post.id);
            case 'settings': return toggleSettings(true);
            case 'reply': {
                const $slot = $(this).closest('.wf-c-main').children('.wf-reply-slot');
                if ($slot.children().length) { $slot.empty(); return; }
                $slot.html(`<div class="wf-composer sm"><textarea class="wf-reply-input" data-path="${path}" placeholder="Ответ u/${esc(comment.author)}…"></textarea>
<button data-act="send" data-path="${path}">Ответить</button></div>`);
                $slot.find('textarea').trigger('focus');
                return;
            }
            case 'send': {
                const $ta = $(this).siblings('.wf-reply-input');
                const text = String($ta.val() || '').trim();
                if (!text) return;
                const mine = { id: uid(), author: normUser(ctx().name1), flair: '', body: text, score: 1, ts: Date.now(), replies: [], mine: true };
                (comment ? comment.replies : post.comments).push(mine);
                $ta.val('');
                save(); render();
                toastr.info('Жми «Загрузить ещё комментарии» — тебе ответят.', 'Коммент опубликован', { timeOut: 3000 });
                return;
            }
            case 'delc': if (comment) parentList.splice(parentList.indexOf(comment), 1); break;
            case 'delp': {
                const ok = await ctx().Popup.show.confirm('Удалить пост?', esc(post.title));
                if (!ok) return;
                const f = feed(); f.posts.splice(f.posts.indexOf(post), 1);
                break;
            }
            case 'clear': {
                const ok = await ctx().Popup.show.confirm('Очистить ленту?', 'Все посты этого чата будут удалены.');
                if (!ok) return;
                feed().posts = [];
                break;
            }
            default: return;
        }
        save(); render();
    }

    // ---------- настройки и точки входа ----------

    // ---------- страница настроек внутри окна ----------

    let settingsOpen = false;

    function toggleSettings(force) {
        if (!$win) ensureWindow();
        settingsOpen = force ?? !settingsOpen;
        const $page = $win.find('.wf-settings-page');
        if (settingsOpen) { fillSettingsPage($page); $page.show(); $win.find('.wf-body').hide(); }
        else { $page.hide(); $win.find('.wf-body').show(); render(); }
        $win.find('.wf-gear').toggleClass('on', settingsOpen).text(settingsOpen ? '← К ленте' : '⚙ Настройки');
        $win.find('#wf_url_sub').text(settingsOpen ? 'settings/' : (ui.sub ? `r/${ui.sub}/` : ''));
    }

    function openSettings() { open(); toggleSettings(true); }

    function profileOptions() {
        const list = ctx().extensionSettings.connectionManager?.profiles || [];
        return '<option value="">— выбери профиль —</option>' + list
            .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
            .map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.model ? ` · ${esc(p.model)}` : ''}</option>`).join('');
    }

    function contextEstimate() {
        try {
            const chars = worldContext().length;
            return `≈ ${chars.toLocaleString('ru-RU')} симв. контекста (~${Math.round(chars / 3.5).toLocaleString('ru-RU')} ток.) на одно обновление`;
        } catch { return ''; }
    }

    function fillSettingsPage($p) {
        const s = cfg();
        $p.html(`
<div class="wf-set">
  <section class="wf-card wf-set-card">
    <div class="wf-card-h">🔌 Подключение</div>
    <div class="wf-pad">
      <div class="wf-seg">
        <label><input type="radio" name="wf_conn" value="main"> Основное подключение чата</label>
        <label><input type="radio" name="wf_conn" value="profile"> Профиль подключения</label>
        <label><input type="radio" name="wf_conn" value="custom"> Свой API</label>
      </div>
      <div data-show="main" class="wf-hint">Тот же прокси и модель, что сейчас в чате (с её ценой и лимитами).</div>
      <div data-show="profile">
        <label class="wf-f">Профиль из Connection Manager<select data-s="profileId">${profileOptions()}</select></label>
        <div class="wf-hint">Адрес, ключ и модель берутся из профиля. Удобно завести дешёвую модель только для ленты.</div>
      </div>
      <div data-show="custom">
        <label class="wf-f">Адрес API (OpenAI-совместимый)<input data-s="apiUrl" placeholder="https://api.example.com/v1"></label>
        <label class="wf-f">Ключ<span class="wf-keyrow"><input data-s="apiKey" type="password" autocomplete="off" placeholder="sk-…"><button class="wf-btn2" data-do="eye" title="Показать">👁</button></span></label>
        <label class="wf-f">Модель<span class="wf-keyrow"><input data-s="apiModel" list="wf_models" placeholder="gemini-2.5-flash"><button class="wf-btn2" data-do="models">Список</button></span></label>
        <datalist id="wf_models"></datalist>
        <label class="wf-f">Температура<input data-s="temperature" type="number" step="0.05" min="0" max="2"></label>
        <div class="wf-hint">Запрос идёт через сервер таверны, так что CORS не мешает. Ключ хранится в настройках расширения и в ST-секреты не пишется.</div>
      </div>
      <div class="wf-row"><button class="wf-btn" data-do="test">Проверить подключение</button><span class="wf-test-out wf-muted"></span></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">📜 Промт</div>
    <div class="wf-pad">
      <div class="wf-hint">Что генерировать и как: кто пишет, сленг, сабреддиты, запреты. Плейсхолдеры: <code>{{user}}</code>, <code>{{char}}</code>, <code>{{language}}</code>. Формат JSON и лимиты длины расширение добавляет само — их сюда писать не нужно.</div>
      <textarea data-s="systemPrompt" class="wf-prompt" rows="14"></textarea>
      <div class="wf-row"><button class="wf-btn2" data-do="resetPrompt">Вернуть стандартный</button>
        <label class="wf-f wf-inline">Язык<input data-s="language" style="width:120px"></label></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">📰 Посты</div>
    <div class="wf-pad wf-grid">
      <label class="wf-f">Постов за раз, от<input data-s="postsMin" type="number" min="1" max="15"></label>
      <label class="wf-f">до<input data-s="postsMax" type="number" min="1" max="15"></label>
      <label class="wf-f">Комментариев на пост<input data-s="commentsPerPost" type="number" min="0" max="20"></label>
      <label class="wf-f">Макс. символов в посте<input data-s="maxPostChars" type="number" min="80" max="5000"></label>
      <label class="wf-f">Макс. символов в комменте<input data-s="maxCommentChars" type="number" min="40" max="2000"></label>
      <label class="wf-f">Длина ответа модели, токенов<input data-s="responseLength" type="number" min="500" max="32000"></label>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">🧠 Контекст</div>
    <div class="wf-pad wf-grid">
      <label class="wf-f">Последних сообщений чата<input data-s="historyMessages" type="number" min="1" max="300"></label>
      <label class="wf-f">Не больше символов (0 — без лимита)<input data-s="historyMaxChars" type="number" min="0" max="500000" step="1000"></label>
      <label class="wf-chk"><input type="checkbox" data-s="includeCard"> Карточка персонажа и персона</label>
      <div class="wf-hint wf-span wf-ctx-est"></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">🧩 Прочее</div>
    <div class="wf-pad wf-grid">
      <label class="wf-chk"><input type="checkbox" data-s="showFab"> Плавающая кнопка 📰</label>
      <label class="wf-f">Фото к постам<select data-s="imageMode">
        <option value="off">Выключены</option>
        <option value="game">Стиль и внешность — из картинок игры</option>
        <option value="nopeople">Без людей</option>
        <option value="custom">Свой стиль</option></select></label>
      <label class="wf-f wf-span">Свой стиль фото<input data-s="imageStyle"></label>
    </div>
  </section>
</div>`);
        $p.find('[data-s]').each(function () {
            const k = this.dataset.s;
            if (this.type === 'checkbox') this.checked = s[k] !== false && !!s[k];
            else if (k === 'systemPrompt') this.value = s.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            else this.value = s[k] ?? '';
        });
        $p.find(`input[name="wf_conn"][value="${s.conn}"]`).prop('checked', true);
        syncConnVisibility($p);
        $p.find('.wf-ctx-est').text(contextEstimate());
    }

    function syncConnVisibility($p) {
        const conn = cfg().conn;
        $p.find('[data-show]').each(function () { this.style.display = this.dataset.show === conn ? '' : 'none'; });
    }

    let estTimer = 0;
    function bindSettingsPage($p) {
        $p.on('input change', '[data-s]', function () {
            const s = cfg();
            const k = this.dataset.s;
            let v = this.type === 'checkbox' ? this.checked : this.type === 'number' ? Number(this.value) : this.value;
            if (k === 'systemPrompt' && String(v).trim() === DEFAULT_SYSTEM_PROMPT.trim()) v = ''; // стандартный = пусто, чтобы обновлялся вместе с расширением
            s[k] = v;
            ctx().saveSettingsDebounced();
            if (k === 'showFab') placeFab();
            if (['historyMessages', 'historyMaxChars', 'includeCard'].includes(k)) {
                clearTimeout(estTimer);
                estTimer = setTimeout(() => $p.find('.wf-ctx-est').text(contextEstimate()), 250);
            }
        });
        $p.on('change', 'input[name="wf_conn"]', function () {
            cfg().conn = this.value;
            ctx().saveSettingsDebounced();
            syncConnVisibility($p);
            $p.find('.wf-test-out').text('');
        });
        $p.on('click', '[data-do]', async function (e) {
            e.preventDefault();
            const act = this.dataset.do;
            if (act === 'eye') {
                const inp = $p.find('[data-s="apiKey"]')[0];
                inp.type = inp.type === 'password' ? 'text' : 'password';
            } else if (act === 'resetPrompt') {
                cfg().systemPrompt = '';
                $p.find('[data-s="systemPrompt"]').val(DEFAULT_SYSTEM_PROMPT);
                ctx().saveSettingsDebounced();
            } else if (act === 'models') {
                const $out = $p.find('.wf-test-out').text('загружаю модели…');
                try {
                    const ids = await listCustomModels();
                    $p.find('#wf_models').html(ids.map(id => `<option value="${esc(id)}">`).join(''));
                    $out.text(`моделей: ${ids.length} — начни печатать в поле «Модель»`);
                } catch (err) { $out.text('✖ ' + errText(err)); }
            } else if (act === 'test') {
                const $out = $p.find('.wf-test-out').text('проверяю: ' + connLabel() + '…');
                const btn = this; btn.disabled = true;
                const t0 = Date.now();
                try {
                    const r = await callModel('Ответь одним словом.', 'Скажи «работает».', 300);
                    $out.html(`✔ ${esc(connLabel())} · ${((Date.now() - t0) / 1000).toFixed(1)} с · ответ: «${esc(String(r).trim().slice(0, 60))}»`);
                } catch (err) {
                    $out.text('✖ ' + errText(err));
                } finally { btn.disabled = false; }
            }
        });
    }

    async function listCustomModels() {
        const s = cfg();
        if (!s.apiUrl) throw new Error('сначала укажи адрес API');
        const body = { chat_completion_source: 'custom', custom_url: joinApi(s.apiUrl, '') };
        if (s.apiKey) body.custom_include_headers = JSON.stringify({ Authorization: `Bearer ${String(s.apiKey).trim()}` });
        const resp = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body),
        });
        const j = await resp.json().catch(() => null);
        if (!resp.ok || j?.error) throw Object.assign(new Error('прокси не отдал список моделей'), { status: resp.status });
        const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        return arr.map(m => m?.id || m?.name || m).filter(x => typeof x === 'string').sort();
    }

    function mountSettings() {
        const $s = $(`
<div class="inline-drawer wf-settings">
  <div class="inline-drawer-toggle inline-drawer-header"><b>📰 Лента мира (Reddit)</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
  <div class="inline-drawer-content">
    <div class="flex-container">
      <button class="menu_button" id="wf_open_btn">Открыть ленту</button>
      <button class="menu_button" id="wf_set_btn">⚙ Настройки ленты</button>
    </div>
    <small>Подключение, промт, число постов и контекст — в окне ленты, кнопка «⚙ Настройки». В промпт РП лента не попадает.</small>
  </div>
</div>`);
        $s.on('click', '#wf_open_btn', open);
        $s.on('click', '#wf_set_btn', openSettings);
        $('#extensions_settings2').append($s);
    }

    function placeFab() {
        const fab = document.getElementById('wf_fab');
        if (!fab) return;
        const s = cfg();
        fab.style.display = s.showFab ? '' : 'none';
        if (s.fabPos) {
            fab.style.left = Math.min(window.innerWidth - 46, Math.max(0, s.fabPos.x)) + 'px';
            fab.style.top = Math.min(window.innerHeight - 46, Math.max(0, s.fabPos.y)) + 'px';
            fab.style.right = 'auto'; fab.style.bottom = 'auto';
        }
    }

    function mountFab() {
        const fab = $('<div id="wf_fab" title="Лента мира">📰<span id="wf_fab_badge"></span></div>')[0];
        document.body.appendChild(fab);
        let drag = null;
        fab.addEventListener('pointerdown', ev => {
            const r = fab.getBoundingClientRect();
            drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, x: ev.clientX, y: ev.clientY, moved: false };
            fab.setPointerCapture?.(ev.pointerId);
        });
        fab.addEventListener('pointermove', ev => {
            if (!drag) return;
            if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 5) drag.moved = true;
            if (!drag.moved) return;
            fab.style.left = Math.min(window.innerWidth - 46, Math.max(0, ev.clientX - drag.dx)) + 'px';
            fab.style.top = Math.min(window.innerHeight - 46, Math.max(0, ev.clientY - drag.dy)) + 'px';
            fab.style.right = 'auto'; fab.style.bottom = 'auto';
        });
        fab.addEventListener('pointerup', () => {
            if (!drag) return;
            if (drag.moved) { cfg().fabPos = { x: parseInt(fab.style.left), y: parseInt(fab.style.top) }; ctx().saveSettingsDebounced(); }
            else open();
            drag = null;
        });
        window.addEventListener('resize', placeFab);
        placeFab();
    }

    /** Бейдж: сколько постов появилось, пока окно было закрыто. */
    function setBadge(n) {
        const b = document.getElementById('wf_fab_badge');
        if (b) { b.textContent = n ? String(n) : ''; b.style.display = n ? 'block' : 'none'; }
    }

    function mountMenu() {
        const $item = $(`<div id="wf_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
<div class="fa-solid fa-newspaper extensionsMenuExtensionButton"></div><span>Лента мира</span></div>`);
        $item.on('click', open);
        $('#extensionsMenu').append($item);
    }

    function init() {
        cfg();
        mountSettings();
        mountMenu();
        mountFab();
        const c = ctx();
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { ui.open.clear(); ui.sub = ''; render(); });
        try {
            c.SlashCommandParser?.addCommandObject?.(c.SlashCommand.fromProps({
                name: 'feed', helpString: 'Открыть ленту мира (Reddit).',
                callback: () => { open(); return ''; },
            }));
        } catch { /* без слэш-команды */ }
        window.WorldFeed = { callModel, styleRules, worldContext, toggleSettings, openSettings, listCustomModels, DEFAULT_SYSTEM_PROMPT, buildImagePrompt, gameImageInfo, instructionsIn, cap, postsPrompt, open, close, refreshFeed, moreComments, genImage, feed, cfg, parseJson, normPost, render };
    }

    $(init);
})();
