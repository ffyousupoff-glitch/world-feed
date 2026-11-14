// Лента мира — окно-«Reddit» и «Twitter» для ролевого мира. Посты и комментарии пишут
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
        commentHistory: 4,      // для «ещё комментариев»: сколько последних сообщений чата (0 — без чата)
        commentCard: false,     // для комментов: слать ли карточку и персону
        blockPlayer: true,      // персонаж игрока не пишет в ленту
        playerAliases: '',      // другие имена персонажа игрока через запятую
        net: 'reddit',          // открытая вкладка: reddit | twitter
        systemPromptTw: '',     // пусто = стандартный промт Твиттера
        autoReplies: true,      // на свой пост сразу приходят ответы
        systemPromptIg: '',     // пусто = стандартный промт Инстаграма
        igStyle: 'candid smartphone photo, shot on a phone camera, natural light, realistic, slightly imperfect framing, authentic social media snapshot',
        igAutoImages: 3,        // сколько новых постов Инстаграма рисовать самим за одно обновление
        // Свои подключения Инстаграма. Текст: feed — как у ленты; profile; custom.
        igTextConn: 'feed', igProfileId: '', igApiUrl: '', igApiKey: '', igApiModel: '', igTemperature: 1,
        // Фото: hermes — как в Hermes Images; hprofile — другой профиль Hermes Images; custom — свой адрес/ключ/модель.
        igImgConn: 'hermes', igImgProfileId: '', igImgEndpoint: '', igImgKey: '', igImgModel: '', igImgQuality: 'medium',
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
        for (const p of md[META_KEY].posts) if (!p.net) p.net = 'reddit';
        if (!Array.isArray(md[META_KEY].dms)) md[META_KEY].dms = [];
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
    const normHandle = a => (String(a || 'anon').trim().replace(/^@+/, '').replace(/\s+/g, '_') || 'anon');
    const NETS = ['reddit', 'twitter', 'insta'];
    const netOf = () => (NETS.includes(cfg().net) ? cfg().net : 'reddit');
    const isSocial = net => net === 'twitter' || net === 'insta'; // @handle + имя вместо u/
    const normSub = s => (String(s || 'world').trim().replace(/^\/?r\//i, '').replace(/\s+/g, '_') || 'world');

    // ---------- контекст для модели ----------

    function stripHtml(s) {
        return String(s || '').replace(/<img[^>]*>/gi, '[картинка]').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    /** opts.lite — экономный контекст для комментариев: мало истории, без карточки. */
    function worldContext(opts = {}) {
        const c = ctx();
        const lite = !!opts.lite;
        const parts = [];
        let card = {};
        try { card = c.getCharacterCardFields?.() || {}; } catch { /* группа без карточки */ }
        const sub = t => (c.substituteParams ? c.substituteParams(t) : t);
        if (c.groupId) {
            const g = c.groups?.find(x => x.id === c.groupId);
            const names = (g?.members || []).map(av => c.characters.find(ch => ch.avatar === av)?.name).filter(Boolean);
            if (names.length) parts.push(`Участники группового чата: ${names.join(', ')}`);
        }
        if (cfg().includeCard === false || (lite && !cfg().commentCard)) card = {};
        if (card.description) parts.push(`## Персонаж/мир (${c.name2})\n${sub(card.description)}`);
        if (card.personality) parts.push(`## Характер\n${sub(card.personality)}`);
        if (card.scenario) parts.push(`## Сценарий\n${sub(card.scenario)}`);
        if (card.persona) parts.push(`## Персона игрока (${c.name1})\n${sub(card.persona)}`);

        const n = lite ? Math.max(0, Number(cfg().commentHistory ?? 4) || 0) : Math.max(1, Number(cfg().historyMessages) || 20);
        const budget = lite ? Math.min(8000, Math.max(0, Number(cfg().historyMaxChars) || 8000)) : Math.max(0, Number(cfg().historyMaxChars) || 0);
        const all = (n ? (c.chat || []).filter(m => !m.is_system && m.mes).slice(-n) : [])
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
        if (hist.length) parts.push(`## ${lite ? 'Что сейчас происходит в игре (для фона)' : 'Последние события ролевой игры'}\n${hist.join('\n\n')}`);
        return parts.join('\n\n');
    }

    function styleRules(net = netOf()) {
        const s = cfg();
        const c = ctx();
        const tpl = net === 'twitter' ? (String(s.systemPromptTw || '').trim() || DEFAULT_TW_PROMPT)
            : net === 'insta' ? (String(s.systemPromptIg || '').trim() || DEFAULT_IG_PROMPT)
            : (String(s.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT);
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
- Персонаж игрока ({{user}}) НЕ пишет в ленту: ни постов, ни комментариев от его имени, под любым ником. О нём можно только говорить в третьем лице.`;

    const DEFAULT_TW_PROMPT = `Ты — генератор ленты вымышленного Твиттера (X), который существует ВНУТРИ мира ролевой игры. Главный юмор: даже если в сеттинге нет интернета (средневековье, эльфы, древность, космос), жители этого мира сидят в Твиттере и ведут себя как типичный Твиттер 2015–2024-х.

Твиттер — НЕ Реддит. Отличия обязательны:
- Коротко и резко: один твит — одна мысль, часто одна строка. Никаких развёрнутых рассуждений и вежливых обсуждений. Длинное — только тредом «1/», и это редкость.
- Жанры: горячие тейки, ироничные one-liner'ы, «BREAKING:» от инсайдеров и новостных аккаунтов, стан-аккаунты и фанбазы персонажей (капслок, «он ничего не сделал», «мать», «отец»), ратио, «кто спрашивал», цитаты с уничтожающей подписью, «это не тот флекс, о котором ты думаешь», поэтичный саднпостинг в 3 ночи, «никто: / абсолютно никто: / X:», «main character дня», тред-разоблачения, официальные аккаунты крепостей и домов с неловким SMM, пиар-катастрофы, извинения в заметках.
- Ответы под твитами — короткие, злые или восторженные, много реакций одной фразой, споры «по фактам», внезапные эксперты, «поясните за…».
- Аккаунты: отображаемое имя (можно с эмодзи, на языке текста) + @handle латиницей. Галочка «verified» — у знати, официальных аккаунтов и тех, кто её купил (над этим шутят).
- Хэштеги — 0–2 на твит, внутримировые, по-русски или латиницей (#Белерианд, #FeanorDidNothingWrong). Эмодзи уместны, но не в каждом твите.
- Персонажи сохраняют СВОИ характеры и знания, но в формате твита: гордый пишет высокомерные односложные ответы, болтун — треды. Реагируют на реальные события последних сообщений ролевой игры: слухи, искажения, хайп, мемы.
- Не пересказывай чат: пишущие знают о событиях из слухов, могут ошибаться и ссориться.
- Язык текста: {{language}}. @handle — латиницей.
- Персонаж игрока ({{user}}) НЕ пишет твитов и ответов: ни от своего имени, ни под любым ником. О нём можно только говорить и отмечать его в третьем лице.`;

    const DEFAULT_IG_PROMPT = `Ты — генератор ленты вымышленного Инстаграма, который существует ВНУТРИ мира ролевой игры. Главный юмор: даже если в сеттинге нет телефонов (средневековье, эльфы, древность, космос), жители мира сидят в Инстаграме, снимают на телефон и ведут себя как типичный Инстаграм 2016–2024-х.

Инстаграм — НЕ Реддит и НЕ Твиттер. Здесь всё вокруг КАРТИНКИ:
- Каждый пост — одно фото, снятое на телефон. Подпись вторична: эстетика, хвастовство, «случайно» идеальная жизнь, мотивационные цитаты не к месту, «photo dump», «не я выбирал этот вайб», «как прошла моя неделя», завтрак сверху, закат, зеркальное селфи (полностью одетым), «кто узнал локацию?», реклама и коллаборации («промокод FEANOR10 на камни»), блогеры-путешественники, кулинарные аккаунты, официальные аккаунты домов и крепостей, фан-аккаунты, мемные страницы, «пост с намёком» после ссоры.
- Подпись короткая или средняя, с эмодзи и 2–6 хэштегами в конце (внутримировые). Геометка — внутримировое место с лёгкой иронией.
- Комментарии короткие: «😍😍😍», «мать», «кто фотографировал?», «а где ты был, когда...», пассивная агрессия, «прекрасно выглядишь» от тех, кто ненавидит, боты («Классный профиль! Напиши в директ 💸»), фанаты.
- Персонажи сохраняют СВОИ характеры: гордый выкладывает пафосное фото с одним словом в подписи, тщеславный — двадцать селфи, мрачный — чёрно-белый пейзаж. Реагируют на реальные события последних сообщений ролевой игры, но через то, что выкладывают и о чём умалчивают.
- Не пересказывай чат: подписчики знают о событиях из слухов.
- Язык текста: {{language}}. @handle — латиницей. Описание фото (image_prompt) — на английском.
- Персонаж игрока ({{user}}) НЕ публикует постов и не пишет комментариев. Его можно только упоминать, отмечать, и он может оказаться на чужом фото.`;

    const TWEET_REPLY_SCHEMA = `{"name":"отображаемое имя","handle":"ник латиницей без @","verified":false,"body":"текст ответа","likes":число,"replies":[ ...такие же объекты, вложенность до 2 уровней... ]}`;

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
                    const m = list[j].prompt.match(/Characters?\s*:\s*([\s\S]*?)(?=\b(?:Lighting|Location|Setting|Layout|Background(?: elements)?|Panels?(?:\s*\d)?|Composition|Camera|Mood|Atmosphere|Action|Scene|Style|Format|Negative)\s*:|ABSOLUTELY|$)/i);
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

    /** Явный запрет с именами — дописывается к любому промту, даже пользовательскому. */
    function playerRule() {
        if (cfg().blockPlayer === false) return '';
        const names = [ctx().name1, ...String(cfg().playerAliases || '').split(/[,;\n]/)].map(x => x.trim()).filter(Boolean);
        return `\nВАЖНО: ${names.join(' / ')} — персонаж ИГРОКА. Он не автор: никаких постов и комментариев от его лица и ников, похожих на его имена (${names.map(n => translit(n).replace(/\s+/g, '_')).join(', ')} и т.п.). Его комменты появляются в ленте только когда игрок пишет их сам.\n`;
    }

    function tweetsPrompt() {
        const s = cfg();
        const f = feed();
        const recent = f.posts.filter(p => p.net === 'twitter').slice(0, 15).map(p => `- @${p.author}: ${String(p.body).slice(0, 90)}`).join('\n');
        const min = Math.max(1, Number(s.postsMin) || 1), max = Math.max(min, Number(s.postsMax) || 3) + 2;
        return `${worldContext()}

${recent ? `## Уже в ленте (не повторяй)\n${recent}\n\n` : ''}## Задание
Сгенерируй от ${min + 1} до ${max} новых твитов по свежим событиям ролевой игры. Разные голоса и форматы: инсайдер с BREAKING, стан-аккаунт, ироничный тейк, официальный аккаунт, саднпост, мем-шаблон, цитата-ратио.
У каждого твита от 1 до ${s.commentsPerPost} ответов, ответы на ответы — редко.
ДЛИНА СТРОГО: твит не длиннее 280 символов (большинство 40–150), ответ не длиннее ${Math.min(200, s.maxCommentChars)} символов.
${imageGuidance()}
${playerRule()}
Ответь ТОЛЬКО JSON без пояснений:
{"posts":[{"name":"отображаемое имя","handle":"ник латиницей без @","verified":false,"body":"текст твита","image_prompt":"...","likes":число,"retweets":число,"replies":[${TWEET_REPLY_SCHEMA}]}]}`;
    }

    /** Внешность персонажей для инсты — из тегов картинок игры. */
    function igAppearance() {
        const g = gameImageInfo();
        return g.chars ? `\nВнешность героев ролевой игры (для справки: если герой в кадре — назови его по имени в image_prompt, внешность подставится сама; сам по умолчанию героев в кадр не ставь):\n${g.chars}\n` : '';
    }

    function igPrompt() {
        const s = cfg();
        const f = feed();
        const recent = f.posts.filter(p => p.net === 'insta').slice(0, 12).map(p => `- @${p.author}: ${String(p.image?.prompt || '').slice(0, 70)} / ${String(p.body).slice(0, 50)}`).join('\n');
        const min = Math.max(1, Number(s.postsMin) || 1), max = Math.max(min, Number(s.postsMax) || 3);
        return `${worldContext()}
${igAppearance()}
${recent ? `## Уже в ленте (не повторяй кадры)\n${recent}\n\n` : ''}## Задание
Сгенерируй от ${min} до ${max} новых постов Инстаграма по свежим событиям ролевой игры. Разные аккаунты и типы кадров: селфи, портрет от друга, еда/стол сверху, пейзаж или вид из окна, предмет крупным планом, групповое фото, «случайный» кадр, скриншот-мем недопустим (на фото нет текста).
image_prompt ОБЯЗАТЕЛЕН для каждого поста и у каждого свой: описание ОДНОГО фото НА АНГЛИЙСКОМ, 1–3 предложения, как реально снято на телефон ЭТИМ автором (ракурс, свет, что в кадре). Фото показывает жизнь и взгляд автора поста: его работу, еду, вещи, место, его самого или его знакомых. Героев ролевой игры в кадр ставь ТОЛЬКО если пост именно про встречу с ними (и называй их тогда по имени); в большинстве постов их в кадре нет. Не копируй сцены из чата и не делай коллажей. Люди в кадре полностью и уместно одеты по ситуации, обычное телосложение, никакого фансервиса, без голых торсов. На фото НЕТ надписей, текста и интерфейса.
У каждого поста ${s.commentsPerPost} комментариев, ответы — редко.
ДЛИНА: подпись не длиннее ${Math.min(400, s.maxPostChars)} символов, комментарий не длиннее ${Math.min(150, s.maxCommentChars)} символов.
${playerRule()}
Ответь ТОЛЬКО JSON без пояснений:
{"posts":[{"name":"отображаемое имя","handle":"ник латиницей без @","verified":false,"location":"геометка или пусто","image_prompt":"...","body":"подпись с хэштегами","likes":число,"replies":[${TWEET_REPLY_SCHEMA}]}]}`;
    }

    function postsPrompt(net = netOf()) {
        if (net === 'twitter') return tweetsPrompt();
        if (net === 'insta') return igPrompt();
        const s = cfg();
        const f = feed();
        const recent = f.posts.filter(p => p.net !== 'twitter').slice(0, 12).map(p => `- r/${p.sub}: ${p.title}`).join('\n');
        const min = Math.max(1, Number(s.postsMin) || 1), max = Math.max(min, Number(s.postsMax) || 3);
        return `${worldContext()}

${recent ? `## Уже опубликовано (не повторяй темы)\n${recent}\n\n` : ''}## Задание
Сгенерируй от ${min} до ${max} новых постов ленты по свежим событиям ролевой игры. Посты разные по формату: короткие мемы, вопросы, AITA, новости-слухи, жалобы, фото с подписью.
У каждого поста ${s.commentsPerPost} комментариев верхнего уровня, ответы на них — редко и коротко.
ДЛИНА СТРОГО: текст поста не длиннее ${s.maxPostChars} символов (лучше короче, многие посты — 1–2 строки или только заголовок), каждый комментарий не длиннее ${s.maxCommentChars} символов. Это соцсеть, а не летопись: никаких полотен, списков на десять пунктов и пересказов.
${imageGuidance()}
${playerRule()}
Ответь ТОЛЬКО JSON без пояснений:
{"posts":[{"sub":"название сабреддита","author":"ник","flair":"флер поста или пусто","title":"заголовок","body":"текст поста (может быть пустым, если пост-картинка)","image_prompt":"...","score":число,"comments":[${COMMENT_SCHEMA}]}]}`;
    }

    function threadToText(list, depth = 0) {
        return (list || []).map(c => `${'  '.repeat(depth)}- u/${c.author}: ${c.body}\n${threadToText(c.replies, depth + 1)}`).join('');
    }

    function moreTweetsPrompt(post) {
        return `${worldContext({ lite: true })}

## Твит
${post.name || post.author} (@${post.author})${post.mine ? ' — это твит игрока' : ''}
${post.body || ''}

## Ответы сейчас
${threadToText(post.comments).replace(/u\//g, '@') || '(пока нет)'}

## Задание
Добавь ещё ${cfg().commentsPerPost} ответов (каждый не длиннее ${Math.min(200, cfg().maxCommentChars)} символов): новые люди приходят из рекомендаций, отвечают автору и друг другу (особенно на ответы @${normHandle(ctx().name1)}, если есть — ответь каждому), устраивают ратио, стан-войны или мем.
${playerRule()}Ответь ТОЛЬКО JSON:
{"new":[${TWEET_REPLY_SCHEMA}],"replies":[{"to":"точный handle автора, которому отвечают","to_text":"первые слова его ответа","comment":${TWEET_REPLY_SCHEMA}}]}`;
    }

    function moreIgPrompt(post) {
        return `${worldContext({ lite: true })}

## Пост в Инстаграме
${post.name || post.author} (@${post.author})${post.mine ? ' — это пост игрока' : ''}${post.location ? ` · 📍${post.location}` : ''}
Фото: ${post.image?.prompt || '(фото)'}
Подпись: ${post.body || ''}

## Комментарии сейчас
${threadToText(post.comments).replace(/u\//g, '@') || '(пока нет)'}

## Задание
Добавь ещё ${cfg().commentsPerPost} комментариев (каждый не длиннее ${Math.min(150, cfg().maxCommentChars)} символов): подписчики, друзья, завистники, фанаты, боты; отвечают автору и друг другу (особенно на комменты @${normHandle(translit(ctx().name1 || ''))}, если есть — ответь каждому).
${playerRule()}Ответь ТОЛЬКО JSON:
{"new":[${TWEET_REPLY_SCHEMA}],"replies":[{"to":"точный handle автора, которому отвечают","to_text":"первые слова его коммента","comment":${TWEET_REPLY_SCHEMA}}]}`;
    }

    function morePrompt(post) {
        if (post.net === 'twitter') return moreTweetsPrompt(post);
        if (post.net === 'insta') return moreIgPrompt(post);
        return `${worldContext({ lite: true })}

## Пост
r/${post.sub} · u/${post.author}${post.mine ? ' — это пост игрока: тред отвечает ему' : ''}
${post.title}
${post.body || ''}

## Комментарии сейчас
${threadToText(post.comments) || '(пока нет)'}

## Задание
Добавь ещё ${cfg().commentsPerPost} комментариев (каждый не длиннее ${cfg().maxCommentChars} символов): новые люди заходят в тред, отвечают на существующие комменты (особенно на комменты u/${ctx().name1}, если есть — ответь каждому), разгоняют срач или мем.
${playerRule()}Ответь ТОЛЬКО JSON:
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
    /** Подключение для текста: общее ленты или своё у Инстаграма. */
    function textConn(net) {
        const s = cfg();
        if (net === 'insta' && s.igTextConn && s.igTextConn !== 'feed') {
            return { conn: s.igTextConn, profileId: s.igProfileId, apiUrl: s.igApiUrl, apiKey: s.igApiKey, apiModel: s.igApiModel, temperature: s.igTemperature };
        }
        return { conn: s.conn, profileId: s.profileId, apiUrl: s.apiUrl, apiKey: s.apiKey, apiModel: s.apiModel, temperature: s.temperature };
    }

    async function customCall(system, user, maxTokens, s = textConn()) {
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
    async function callModel(system, user, maxTokens, net) {
        const s = textConn(net);
        const c = ctx();
        if (s.conn === 'custom') return customCall(system, user, maxTokens, s);
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

    async function ask(prompt, net = netOf()) {
        const raw = await callModel(styleRules(net), prompt, Number(cfg().responseLength) || 5000, net);
        return parseJson(raw);
    }

    function connLabel(net) {
        const s = textConn(net);
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

    // ---------- персонаж игрока не пишет в ленту ----------

    const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    const translit = s => String(s).toLowerCase().replace(/[а-яё]/g, ch => TRANSLIT[ch] ?? ch);
    const fold = s => translit(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    /** Имена персонажа игрока: имя персоны + «другие имена» из настроек. */
    function playerAliases() {
        const raw = [ctx().name1, ...String(cfg().playerAliases || '').split(/[,;\n]/)];
        const out = new Set();
        for (const r of raw) {
            const f = fold(r);
            if (f.length >= 3 && !['user', 'you', 'anon', 'player'].includes(f)) out.add(f);
        }
        return [...out];
    }

    /** Ник похож на персонажа игрока? Сравнение по целым частям ника: Kano_Regent, maglor.official, u/Канафинвэ. */
    function isPlayerNick(nick, aliases = playerAliases()) {
        const f = ' ' + fold(String(nick).replace(/([a-z])([A-Z])/g, '$1 $2')) + ' ';
        const glued = f.replace(/ /g, '');
        return aliases.some(a => f.includes(' ' + a + ' ') || (a.length >= 5 && glued.includes(a.replace(/ /g, ''))));
    }

    let dropped = 0;

    /** Чистит уже сохранённую ленту от записей «от лица» игрока (свои комменты игрока — mine — не трогает). */
    function purgePlayer() {
        const f = feed();
        if (!f || cfg().blockPlayer === false) return 0;
        const aliases = playerAliases();
        if (!aliases.length) return 0;
        let n = 0;
        const clean = list => (list || []).filter(c => {
            if (!c.mine && (isPlayerNick(c.author, aliases) || (c.name && isPlayerNick(c.name, aliases)))) { n++; return false; }
            c.replies = clean(c.replies);
            return true;
        });
        f.posts = f.posts.filter(p => {
            if (!p.mine && (isPlayerNick(p.author, aliases) || (p.name && isPlayerNick(p.name, aliases)))) { n++; return false; }
            p.comments = clean(p.comments);
            return true;
        });
        if (n) { save(); console.info(`[world-feed] из сохранённой ленты убрано записей игрока: ${n}`); }
        return n;
    }

    function normComment(c, aliases, tw = false) {
        if (!c || typeof c !== 'object') return null;
        const nick = tw ? (c.handle ?? c.author) : c.author;
        if (cfg().blockPlayer !== false && (isPlayerNick(nick, aliases) || (tw && c.name && isPlayerNick(c.name, aliases)))) { dropped++; return null; } // вместе с ответами на него
        const body = cap(c.body ?? c.text ?? '', tw ? Math.min(280, cfg().maxCommentChars * 1.2) : cfg().maxCommentChars);
        if (!body) return null;
        const pts = tw ? (c.likes ?? c.score) : c.score;
        const out = {
            id: uid(),
            author: tw ? normHandle(nick) : normUser(nick),
            flair: String(c.flair || '').slice(0, 40),
            body,
            score: Number.isFinite(+pts) ? Math.round(+pts) : Math.floor(Math.random() * 300),
            ts: Date.now() - Math.floor(Math.random() * 3 * 3600e3),
            replies: (Array.isArray(c.replies) ? c.replies : []).map(x => normComment(x, aliases, tw)).filter(Boolean),
        };
        if (tw) { out.name = String(c.name || '').trim().slice(0, 50) || out.author; out.verified = !!c.verified; }
        return out;
    }

    function normTweet(p) {
        if (!p || !String(p.body ?? p.text ?? '').trim()) return null;
        const aliases = playerAliases();
        const nick = p.handle ?? p.author;
        if (cfg().blockPlayer !== false && (isPlayerNick(nick, aliases) || (p.name && isPlayerNick(p.name, aliases)))) { dropped++; return null; }
        const likes = Number.isFinite(+p.likes) ? Math.round(+p.likes) : Math.floor(Math.random() * 4000);
        const handle = normHandle(nick);
        return {
            id: uid(),
            net: 'twitter',
            author: handle,
            name: String(p.name || '').trim().slice(0, 50) || handle,
            verified: !!p.verified,
            sub: '', flair: '', title: '',
            body: cap(p.body ?? p.text, 280),
            score: likes,
            retweets: Number.isFinite(+p.retweets) ? Math.round(+p.retweets) : Math.floor(likes / 6),
            views: Math.round(likes * (25 + Math.random() * 40) + 300),
            ts: Date.now() - Math.floor(Math.random() * 40 * 60e3),
            vote: 0,
            image: p.image_prompt && cfg().imageMode !== 'off' ? { prompt: String(p.image_prompt).trim(), src: '' } : null,
            comments: (Array.isArray(p.replies ?? p.comments) ? (p.replies ?? p.comments) : []).map(x => normComment(x, aliases, true)).filter(Boolean),
        };
    }

    function normIg(p) {
        if (!p || !String(p.image_prompt || '').trim()) return null; // в инсте без фото поста нет
        const aliases = playerAliases();
        const nick = p.handle ?? p.author;
        if (cfg().blockPlayer !== false && (isPlayerNick(nick, aliases) || (p.name && isPlayerNick(p.name, aliases)))) { dropped++; return null; }
        const handle = normHandle(nick);
        return {
            id: uid(), net: 'insta', author: handle,
            name: String(p.name || '').trim().slice(0, 50) || handle,
            verified: !!p.verified,
            location: String(p.location || '').trim().slice(0, 60),
            sub: '', flair: '', title: '',
            body: cap(p.body ?? p.caption ?? '', Math.min(400, cfg().maxPostChars)),
            score: Number.isFinite(+p.likes) ? Math.round(+p.likes) : Math.floor(Math.random() * 3000),
            ts: Date.now() - Math.floor(Math.random() * 60 * 60e3),
            vote: 0,
            image: { prompt: String(p.image_prompt).trim(), src: '' },
            comments: (Array.isArray(p.replies ?? p.comments) ? (p.replies ?? p.comments) : []).map(x => normComment(x, aliases, true)).filter(Boolean),
        };
    }

    function normPost(p) {
        if (!p || !String(p.title || '').trim()) return null;
        const aliases = playerAliases();
        if (cfg().blockPlayer !== false && isPlayerNick(p.author, aliases)) { dropped++; return null; }
        return {
            id: uid(),
            net: 'reddit',
            sub: normSub(p.sub),
            author: normUser(p.author),
            flair: String(p.flair || '').slice(0, 40),
            title: String(p.title).trim(),
            body: cap(p.body, cfg().maxPostChars),
            score: Number.isFinite(+p.score) ? Math.round(+p.score) : Math.floor(Math.random() * 5000),
            ts: Date.now(),
            vote: 0,
            image: p.image_prompt && cfg().imageMode !== 'off' ? { prompt: String(p.image_prompt).trim(), src: '' } : null,
            comments: (Array.isArray(p.comments) ? p.comments : []).map(x => normComment(x, aliases)).filter(Boolean),
        };
    }

    let busy = false;

    async function refreshFeed() {
        if (busy) return;
        const chatId = ctx().getCurrentChatId?.();
        if (!chatId) return toastr.info('Сначала открой чат.', 'Лента мира');
        const net = netOf();
        busy = net; renderBusy();
        try {
            const data = await ask(postsPrompt(net), net);
            if (ctx().getCurrentChatId?.() !== chatId) return;
            dropped = 0;
            const raw = Array.isArray(data) ? data : data.posts || data.tweets || [];
            const posts = raw.map(net === 'twitter' ? normTweet : net === 'insta' ? normIg : normPost).filter(Boolean);
            if (net === 'insta') {
                // Сами рисуем первые N новых постов, по одному, когда они попадают на экран.
                const n = Math.max(0, Number(cfg().igAutoImages) || 0);
                posts.slice(0, n).forEach(p => { p.image.auto = true; });
            }
            if (dropped) console.info(`[world-feed] убрано записей от лица персонажа игрока: ${dropped}`);
            if (!posts.length) throw new Error('в ответе нет постов');
            feed().posts.unshift(...posts);
            if (netOf() !== net) unseen[net] += posts.length;
            save();
            if (!isOpen) setBadge(posts.length);
            toastr.success(net === 'twitter' ? `Новых твитов: ${posts.length}` : `Новых постов: ${posts.length}`, 'Лента мира');
            if (net === 'insta' && posts.length < raw.length) console.info(`[world-feed] постов инсты без фото отброшено: ${raw.length - posts.length - dropped}`);
        } catch (e) {
            console.error('[world-feed]', e);
            toastr.error(errText(e), 'Лента не обновилась', { timeOut: 10000 });
        } finally {
            busy = false; render();
        }
    }

    function findComment(list, author, text) {
        const a = normHandle(normUser(author)).toLowerCase();
        const t = String(text || '').toLowerCase().slice(0, 25);
        let fallback = null;
        const walk = l => {
            for (const c of l || []) {
                if (normHandle(c.author).toLowerCase() === a) {
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
            const tw = isSocial(post.net);
            const data = await ask(morePrompt(post), post.net || 'reddit');
            if (ctx().getCurrentChatId?.() !== chatId) return;
            let added = 0;
            dropped = 0;
            const aliases = playerAliases();
            for (const r of data.replies || []) {
                const cm = normComment(r.comment, aliases, tw);
                if (!cm) continue;
                const target = findComment(post.comments, tw ? normHandle(r.to) : r.to, r.to_text);
                (target ? target.replies : post.comments).push(cm);
                added++;
            }
            for (const n of data.new || []) {
                const cm = normComment(n, aliases, tw);
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
    /** Блок «Characters:» → [{names:[...], text}] по одному персонажу. */
    function splitCharacters(chars) {
        return String(chars || '').split(/;\s*/).map(x => x.trim()).filter(Boolean).map(text => {
            const head = text.split(',')[0];
            const names = [head.replace(/\(.*?\)/g, ''), ...(head.match(/\(([^)]+)\)/g) || []).map(x => x.slice(1, -1))]
                .flatMap(n => [n, ...n.split(/\s+/)]).map(n => n.trim()).filter(n => n.length >= 3 && !/^(the|and|male|female|young|old|elf|man|woman|canon|lady|lord|sir)$/i.test(n));
            return { names: [...new Set(names)], text };
        });
    }

    /** Только те персонажи игры, кого описание кадра называет по имени. */
    function charsInScene(scene, chars) {
        const low = ' ' + String(scene).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
        return splitCharacters(chars).filter(c => c.names.some(n => low.includes(' ' + n.toLowerCase() + ' ')));
    }

    function buildImagePrompt(scene, hcfg, net) {
        const s = cfg();
        const parts = [];
        let useRefs = false;
        if (net === 'insta') {
            // Кадр — только то, что описано для ЭТОГО поста. Никаких картинок игры как образца
            // (это комикс-страницы: рисовалка копирует их раскладку и героев) и никаких чужих героев.
            const who = charsInScene(scene, gameImageInfo().chars);
            parts.push(`Style: ${s.igStyle || DEFAULTS.igStyle}.`);
            parts.push(`ONE single photograph taken on a smartphone and posted to Instagram. Photographic and realistic — not a painting, not an illustration, not a comic, not a collage, no panels, no split frames, no multiple shots. Vertical 4:5 framing.`);
            parts.push(scene);
            if (who.length) parts.push(`Appearance of the named people in this photo (render them as real people; keep faces, hair, ears and distinctive marks; clothing and pose follow the scene above, not this note):\n${who.map(c => c.text).join('\n')}`);
            else parts.push('Show only who and what the scene describes; no other recognizable characters.');
            parts.push(DRESSED + ' ' + NO_TEXT);
            useRefs = false;
        } else if (s.imageMode === 'nopeople') {
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

    // Очередь автоотрисовки Инстаграма: строго по одному, только то, что докрутили.
    const drawQueue = [];
    let drawing = false, io = null;
    function queueDraw(id) {
        if (drawQueue.includes(id)) return;
        drawQueue.push(id);
        pumpDraw();
    }
    async function pumpDraw() {
        if (drawing) return;
        drawing = true;
        try {
            while (drawQueue.length) {
                const id = drawQueue.shift();
                const p = feed()?.posts.find(x => x.id === id);
                if (p?.image?.auto && !p.image.src && !p.image.busy) await genImage(id);
            }
        } finally { drawing = false; }
    }
    function watchAutoImages() {
        const els = $win?.find('[data-auto="1"]').toArray() || [];
        if (!els.length) return;
        if (typeof IntersectionObserver === 'undefined') { els.forEach(el => queueDraw(el.dataset.path)); return; }
        io ??= new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queueDraw(e.target.dataset.path); }
        }, { root: $win.find('.wf-feed')[0], rootMargin: '200px' });
        els.forEach(el => io.observe(el));
    }

    /** Настройки рисовалки для поста: у Инстаграма может быть своё подключение. */
    function imageCfg(hcfg, net) {
        const s = cfg();
        if (net !== 'insta' || !s.igImgConn || s.igImgConn === 'hermes') return hcfg;
        if (s.igImgConn === 'hprofile') {
            const pr = (hcfg.profiles || []).find(x => x.id === s.igImgProfileId);
            if (!pr) throw new Error('профиль Hermes Images для Инстаграма не выбран или удалён (Настройки ленты → Инстаграм)');
            return { ...hcfg, endpoint: pr.endpoint, apiKey: pr.apiKey, model: pr.model, quality: pr.quality, extraJson: pr.extraJson || '' };
        }
        if (!s.igImgEndpoint || !s.igImgKey || !s.igImgModel) throw new Error('для фото Инстаграма не заполнены адрес, ключ или модель (Настройки ленты → Инстаграм)');
        return { ...hcfg, endpoint: s.igImgEndpoint.trim(), apiKey: s.igImgKey.trim(), model: s.igImgModel.trim(), quality: s.igImgQuality || 'auto', extraJson: '' };
    }

    function imageLabel(hcfg) {
        const s = cfg();
        if (s.igImgConn === 'custom') { try { return `${new URL(s.igImgEndpoint).host} · ${s.igImgModel || '?'}`; } catch { return 'свой адрес (не задан)'; } }
        if (s.igImgConn === 'hprofile') { const pr = (hcfg?.profiles || []).find(x => x.id === s.igImgProfileId); return pr ? `профиль Hermes «${pr.name}» · ${pr.model}` : 'профиль Hermes не выбран'; }
        return hcfg ? `как в Hermes Images · ${hcfg.model}` : 'как в Hermes Images';
    }

    async function genImage(postId) {
        const post = feed()?.posts.find(p => p.id === postId);
        if (!post) return;
        if (!post.image) post.image = { prompt: '', src: '' };
        if (!post.image.prompt) {
            if (post.image.auto) return; // автозапуск без промта не спрашивает
            const p = await ctx().Popup.show.input('Фото к посту', 'Что на снимке? (лучше по-английски)', post.title || String(post.body || '').slice(0, 120));
            if (!p) return;
            post.image.prompt = p;
        }
        if (post.image.busy) return;
        let prov, settings;
        try {
            prov = await import(HI_BASE + 'provider.js');
            settings = await import(HI_BASE + 'settings.js');
        } catch (e) {
            delete post.image.auto; save(); render(); // иначе автоочередь будет пробовать снова на каждой перерисовке
            return toastr.error('Нужно расширение Hermes Images — оно рисует картинки. ' + errText(e), 'Лента мира');
        }
        post.image.busy = true; post.image.error = ''; render();
        try {
            const hcfg = imageCfg(settings.getCfg(), post.net);
            const { prompt, useRefs } = buildImagePrompt(post.image.prompt, hcfg, post.net);
            let refs = [];
            if (useRefs) {
                try { refs = await (await import(HI_BASE + 'refs.js')).collectRefs(hcfg); }
                catch (e) { console.warn('[world-feed] refs', e); }
            }
            const dataUrl = await prov.generateImage({ prompt, aspect: post.net === 'insta' ? '4:5' : '4:3', refs, cfg: hcfg });
            post.image.src = await uploadImage(dataUrl);
            delete post.image.auto;
            save();
        } catch (e) {
            console.error('[world-feed] image', e);
            const t = (prov.describeError && e?.code !== undefined) ? prov.describeError(e) : errText(e);
            post.image.error = t;
            delete post.image.auto;
            toastr.error(t, 'Фото не сгенерировалось', { timeOut: 10000 });
        } finally {
            delete post.image.busy; save(); render();
        }
    }

    // ---------- окно ----------

    let $win = null;
    let isOpen = false;
    const ui = { open: new Set(), expanded: new Set(), sub: '', tag: '', sort: 'new', composing: false };

    const unseen = { reddit: 0, twitter: 0, insta: 0 }; // посты, пришедшие в фоновую вкладку

    function switchNet(net) {
        net = NETS.includes(net) ? net : 'reddit';
        if (cfg().net === net) return;
        cfg().net = net;
        ctx().saveSettingsDebounced();
        ui.sub = ''; ui.tag = ''; ui.composing = false; ui.dm = null; ui.dmView = false; // другая вкладка — другой сайт, открываем его ленту
        if (settingsOpen) toggleSettings(false);
        render();
        $win?.find('.wf-feed').scrollTop(0);
    }
    const LONG_POST = 320;

    function ensureWindow() {
        if ($win) return $win;
        $win = $(`
<div id="wf_window" class="wf-root" style="display:none">
  <div class="wf-browser">
    <div class="wf-chrome">
      <span class="wf-dots"><i></i><i></i><i></i></span>
      <div class="wf-tabs">
        <div class="wf-tab" data-net="reddit" title="reddit.world"><span class="wf-fav wf-fav-r">👽</span><span class="wf-tab-t">Reddit — главная мира</span><span class="wf-tab-badge"></span></div>
        <div class="wf-tab" data-net="twitter" title="x.world"><span class="wf-fav wf-fav-x">𝕏</span><span class="wf-tab-t">Главная / X</span><span class="wf-tab-badge"></span></div>
        <div class="wf-tab" data-net="insta" title="instagram.world"><span class="wf-fav wf-fav-ig">◎</span><span class="wf-tab-t">Instagram</span><span class="wf-tab-badge"></span></div>
        <span class="wf-tab-plus" title="Новых соцсетей в этом мире пока не изобрели">+</span>
      </div>
      <span class="wf-close" title="Закрыть">✕</span>
    </div>
    <div class="wf-addr">
      <span class="wf-navbtn" title="Назад">←</span><span class="wf-navbtn" title="Вперёд">→</span><span class="wf-navbtn wf-reload" title="Обновить ленту">⟳</span>
      <span class="wf-url"><span class="wf-lock">🔒</span><span id="wf_url_host">https://www.reddit.world/</span><span id="wf_url_sub"></span></span>
    </div>
    <div class="wf-topbar">
      <span class="wf-logo"></span>
      <span class="wf-sort"></span>
      <button class="wf-dm-btn" data-act="dmlist" title="Личные сообщения">✉ <span class="wf-dm-label">Сообщения</span><span class="wf-dm-badge"></span></button>
      <button class="wf-compose-btn" data-act="compose">✏ Пост</button>
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

        $win.on('click', '.wf-close', () => close());
        $win.on('click', function (e) { if (e.target === this) close(); });
        $win.on('click', '.wf-set-back button', () => toggleSettings(false));
        $win.on('click', '.wf-refresh, .wf-reload', () => { if (!settingsOpen) refreshFeed(); });
        $win.on('click', '.wf-gear', () => toggleSettings());
        bindSettingsPage($win.find('.wf-settings-page'));
        $win.on('click', '[data-sort]', function () { ui.sort = this.dataset.sort; render(); });
        $win.on('click', '[data-net]', function () { switchNet(this.dataset.net); });
        $win.on('click', '[data-tag]', function () { ui.tag = this.dataset.tag; render(); $win.find('.wf-feed').scrollTop(0); });
        $win.on('input', '.wf-new-body, .wf-tw-input', function () {
            const $c = $(this).closest('.wf-newpost, .wf-tw-compose').find('.wf-count');
            if ($c.length) { const n = 280 - this.value.length; $c.text(n).toggleClass('wf-over', n < 0); }
        });
        $win.on('keydown', '.wf-new-body, .wf-tw-input, .wf-new-title', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $(this).closest('.wf-newpost, .wf-tw-compose').find('[data-act="publish"]').trigger('click');
        });
        $win.on('click', '[data-sub]', function () { ui.sub = this.dataset.sub; render(); $win.find('.wf-feed').scrollTop(0); });
        $win.on('click', '.wf-spoiler', function () { $(this).toggleClass('wf-shown'); });
        $win.on('click', '[data-act]', onAction);
        $win.on('keydown', '.wf-dm-input', function (e) {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $win.find('[data-act="dmsend"]').trigger('click'); }
        });
        $win.on('keydown', '.wf-dm-to', function (e) { if (e.key === 'Enter') $win.find('[data-act="dmnew"]').trigger('click'); });
        $win.on('keydown', '.wf-reply-input', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $(this).siblings('[data-act="send"]').trigger('click');
        });
        $(document).on('keydown.wf', e => {
            if (e.key !== 'Escape' || !isOpen) return;
            if (settingsOpen) toggleSettings(false); else close();
        });
        return $win;
    }

    // Кнопка «Назад» на телефоне: закрывает настройки, потом окно, а не уводит со страницы.
    let historyArmed = false;
    function armHistory() {
        if (historyArmed) return;
        try { history.pushState({ wf: 1 }, ''); historyArmed = true; } catch { /* sandbox */ }
    }
    window.addEventListener('popstate', () => {
        if (!historyArmed) return;
        historyArmed = false;
        if (!isOpen) return;
        if (settingsOpen) { toggleSettings(false); armHistory(); } else close(true);
    });

    function open() { isOpen = true; setBadge(0); purgePlayer(); ensureWindow().fadeIn(120); render(); armHistory(); }
    function close(fromHistory) {
        isOpen = false;
        $win?.fadeOut(120);
        if (historyArmed && fromHistory !== true) { historyArmed = false; try { history.back(); } catch { /* */ } }
    }

    function sorted(posts) {
        const net = netOf();
        const arr = posts.filter(p => p.net === net && (net === 'insta'
            ? (!ui.tag || (ui.tag.startsWith('@') ? p.author === ui.tag.slice(1) : tagsOf(p.body).includes(ui.tag)))
            : net === 'twitter'
            ? (!ui.tag || tagsOf(p.body).includes(ui.tag))
            : (!ui.sub || p.sub === ui.sub)));
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
    <b class="${isUser ? 'wf-me' : 'wf-dmable'}" ${isUser ? '' : dmAttr(c)}>u/${esc(c.author)}</b>${c.flair ? `<span class="wf-flair">${esc(c.flair)}</span>` : ''}
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
    <span class="wf-muted">Опубликовал <span class="${p.mine ? '' : 'wf-dmable'}" ${p.mine ? '' : dmAttr(p)}>u/${esc(p.author)}</span> · ${ago(p.ts)}</span></div>
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

    const tagsOf = t => [...new Set((String(t || '').match(/#[\p{L}\p{N}_]{2,40}/gu) || []).map(x => x.toLowerCase()))];

    /** Текст твита: markdown + подсветка #тегов и @упоминаний. */
    function twText(s) {
        return md(s).replace(/(^|[\s(>])(#[\p{L}\p{N}_]{2,40})/gu, (m, a, t) => `${a}<span class="wf-tw-link" data-tag="${esc(t.toLowerCase())}">${t}</span>`)
            .replace(/(^|[\s(>])@([A-Za-z0-9_]{2,30})/g, '$1<span class="wf-tw-link">@$2</span>');
    }

    function twHead(c) {
        return `<span class="wf-tw-name ${c.mine ? 'wf-me' : 'wf-dmable'}" ${c.mine ? '' : dmAttr(c)}>${esc(c.name || c.author)}</span>${c.verified ? '<span class="wf-tw-check" title="verified">✓</span>' : ''}
<span class="wf-muted">@${esc(c.author)} · ${ago(c.ts)}</span>`;
    }

    function twAva(name, big) {
        return `<span class="wf-tw-ava ${big ? '' : 'sm'}" style="background:${avatarColor(name)}">${esc(String(name || '?').replace(/^[^\p{L}\p{N}]+/u, '')[0] || '?').toUpperCase()}</span>`;
    }

    function tweetReplyHtml(c, postId) {
        const path = `${postId}|${c.id}`;
        return `<div class="wf-tw-reply" data-cid="${c.id}">
${twAva(c.name || c.author)}
<div class="wf-tw-main">
  <div class="wf-tw-head">${twHead(c)}</div>
  <div class="wf-tw-text">${twText(c.body)}</div>
  <div class="wf-tw-actions">
    <button data-act="reply" data-path="${path}">💬 ${countComments(c.replies) || ''}</button>
    <button data-act="up" data-path="${path}" class="${c.vote > 0 ? 'wf-liked' : ''}">${c.vote > 0 ? '❤' : '♡'} ${fmtScore((c.score || 0) + (c.vote > 0 ? 1 : 0))}</button>
    <button data-act="delc" data-path="${path}" title="Удалить">🗑</button>
  </div>
  <div class="wf-reply-slot"></div>
  ${(c.replies || []).map(r => tweetReplyHtml(r, postId)).join('')}
</div></div>`;
    }

    function tweetHtml(p) {
        const isOpen = ui.open.has(p.id);
        const n = countComments(p.comments);
        const liked = p.vote > 0;
        return `<article class="wf-tweet" data-pid="${p.id}">
${twAva(p.name || p.author, true)}
<div class="wf-tw-main">
  <div class="wf-tw-head">${twHead(p)}</div>
  <div class="wf-tw-text big">${twText(p.body)}</div>
  ${imageHtml(p)}
  <div class="wf-tw-actions">
    <button data-act="toggle" data-path="${p.id}" title="Ответы">💬 ${n}</button>
    <button data-act="rt" data-path="${p.id}" class="${p.rt ? 'wf-rted' : ''}" title="Ретвит">🔁 ${fmtScore((p.retweets || 0) + (p.rt ? 1 : 0))}</button>
    <button data-act="up" data-path="${p.id}" class="${liked ? 'wf-liked' : ''}" title="Нравится">${liked ? '❤' : '♡'} ${fmtScore((p.score || 0) + (liked ? 1 : 0))}</button>
    <span class="wf-muted" title="Просмотры">📊 ${fmtScore(p.views || 0)}</span>
    ${p.image || cfg().imageMode === 'off' ? '' : `<button data-act="img" data-path="${p.id}" title="Фото">📷</button>`}
    ${p.image?.src ? `<button data-act="reimg" data-path="${p.id}" title="Другое фото">🔄</button>` : ''}
    <button data-act="delp" data-path="${p.id}" title="Удалить">🗑</button>
  </div>
  ${isOpen ? `<div class="wf-tw-thread">
    <div class="wf-composer sm"><textarea class="wf-reply-input" data-path="${p.id}" placeholder="Ответить @${esc(p.author)}… (Ctrl+Enter)"></textarea>
      <button data-act="send" data-path="${p.id}">Ответить</button></div>
    ${p.comments.map(c => tweetReplyHtml(c, p.id)).join('') || '<div class="wf-muted wf-pad">Ответов пока нет…</div>'}
    <button class="wf-more" data-act="more" data-path="${p.id}" ${postBusy.has(p.id) ? 'disabled' : ''}>${postBusy.has(p.id) ? '<span class="wf-spin"></span> печатают…' : '⬇ Ещё ответы'}</button>
  </div>` : ''}
</div></article>`;
    }

    function igImage(p) {
        const im = p.image || {};
        if (im.src) return `<div class="wf-ig-photo"><img src="${esc(im.src)}" data-act="zoom" data-path="${p.id}" loading="lazy" alt=""></div>`;
        if (im.busy) return `<div class="wf-ig-photo wf-ig-ph"><span class="wf-spin"></span><small>проявляется…</small></div>`;
        return `<div class="wf-ig-photo wf-ig-ph" data-act="img" data-path="${p.id}" ${im.auto ? 'data-auto="1"' : ''} title="${esc(im.prompt)}">
<span class="wf-ig-cam">📷</span><small>${esc(String(im.prompt || '').slice(0, 180))}</small>
${im.error ? `<small class="wf-err">${esc(im.error)}</small>` : ''}<u>${im.auto ? 'в очереди…' : 'нажми, чтобы проявить фото'}</u></div>`;
    }

    function igCommentHtml(c, postId) {
        const path = `${postId}|${c.id}`;
        return `<div class="wf-ig-c" data-cid="${c.id}">${twAva(c.name || c.author)}
<div class="wf-tw-main"><div><b class="${c.mine ? 'wf-me' : 'wf-dmable'}" ${c.mine ? '' : dmAttr(c)}>${esc(c.author)}</b>${c.verified ? '<span class="wf-tw-check">✓</span>' : ''} ${twText(c.body)}</div>
<div class="wf-ig-cmeta"><span>${ago(c.ts)}</span><span>${fmtScore((c.score || 0) + (c.vote > 0 ? 1 : 0))} отметок «Нравится»</span>
<button data-act="reply" data-path="${path}">Ответить</button><button data-act="delc" data-path="${path}" title="Удалить">🗑</button></div>
<div class="wf-reply-slot"></div>
${(c.replies || []).map(r => igCommentHtml(r, postId)).join('')}</div>
<button class="wf-ig-heart ${c.vote > 0 ? 'wf-liked' : ''}" data-act="up" data-path="${path}">${c.vote > 0 ? '❤' : '♡'}</button></div>`;
    }

    function igHtml(p) {
        const open = ui.open.has(p.id);
        const n = countComments(p.comments);
        const liked = p.vote > 0;
        return `<article class="wf-ig" data-pid="${p.id}">
<div class="wf-ig-head"><span class="wf-ig-ring">${twAva(p.name || p.author)}</span>
  <div class="wf-ig-who"><b class="${p.mine ? 'wf-me' : 'wf-dmable'}" ${p.mine ? '' : dmAttr(p)}>${esc(p.author)}</b>${p.verified ? '<span class="wf-tw-check">✓</span>' : ''}<span class="wf-muted"> · ${ago(p.ts)}</span>${p.location ? `<br><small>${esc(p.location)}</small>` : ''}</div>
  <button class="wf-ig-more" data-act="delp" data-path="${p.id}" title="Удалить пост">🗑</button></div>
${igImage(p)}
<div class="wf-ig-actions">
  <button data-act="up" data-path="${p.id}" class="${liked ? 'wf-liked' : ''}" title="Нравится">${liked ? '❤' : '♡'}</button>
  <button data-act="toggle" data-path="${p.id}" title="Комментарии">💬</button>
  <button data-act="award" data-path="${p.id}" title="Отправить">✈</button>
  ${p.image?.src ? `<button data-act="reimg" data-path="${p.id}" title="Переснять фото">🔄</button>` : ''}
  <button data-act="rt" data-path="${p.id}" class="wf-ig-save ${p.rt ? 'on' : ''}" title="Сохранить">🔖</button>
</div>
<div class="wf-ig-text">
  <b>${fmtScore((p.score || 0) + (liked ? 1 : 0))} отметок «Нравится»</b>
  ${p.body ? `<div><b>${esc(p.author)}</b> ${twText(p.body)}</div>` : ''}
  ${n && !open ? `<button class="wf-ig-all" data-act="toggle" data-path="${p.id}">Посмотреть все комментарии (${n})</button>` : ''}
  ${open ? `<div class="wf-ig-thread">
    ${p.comments.map(c => igCommentHtml(c, p.id)).join('') || '<div class="wf-muted">Комментариев пока нет.</div>'}
    <div class="wf-composer sm"><textarea class="wf-reply-input" data-path="${p.id}" placeholder="Добавьте комментарий… (Ctrl+Enter)"></textarea>
      <button data-act="send" data-path="${p.id}">Опубликовать</button></div>
    <button class="wf-more" data-act="more" data-path="${p.id}" ${postBusy.has(p.id) ? 'disabled' : ''}>${postBusy.has(p.id) ? '<span class="wf-spin"></span> печатают…' : '⬇ Ещё комментарии'}</button>
  </div>` : ''}
</div></article>`;
    }

    function storiesHtml(posts) {
        const seen = new Map();
        for (const p of posts) if (!seen.has(p.author)) seen.set(p.author, p);
        if (!seen.size) return '';
        return `<div class="wf-ig-stories"><div class="wf-ig-story ${ui.tag ? '' : 'on'}" data-tag=""><span class="wf-ig-ring"><span class="wf-tw-ava" style="background:#262626">⌂</span></span><small>Все</small></div>
${[...seen.values()].slice(0, 20).map(p => `<div class="wf-ig-story ${ui.tag === '@' + p.author ? 'on' : ''}" data-tag="@${esc(p.author)}"><span class="wf-ig-ring">${twAva(p.name || p.author)}</span><small>${esc(p.author)}</small></div>`).join('')}</div>`;
    }

    let hiCfgCache = null;
    import(HI_BASE + 'settings.js').then(m => { hiCfgCache = m.getCfg(); }).catch(() => { /* нет Hermes Images */ });

    function igSideHtml(posts) {
        const me = ctx().name1 || 'я';
        return `<div class="wf-card wf-pad wf-ig-me">${twAva(me, true)}<div><b>${esc(normHandle(translit(me)))}</b><br><span class="wf-muted">${esc(me)}</span></div></div>
<div class="wf-card wf-pad wf-muted">Фото: стиль «снято на телефон», у каждого поста свой кадр; внешность героя игры подставляется, только если он назван в кадре. Сами рисуются ${Number(cfg().igAutoImages) || 0} новых поста за обновление, по одному, пока листаешь; остальные — по нажатию.</div>
<div class="wf-card wf-pad wf-muted">🔌 текст: ${esc(connLabel('insta'))}<br>🖼 фото: ${esc(imageLabel(hiCfgCache))}<br><button class="wf-linkbtn wf-blue" data-act="settings">⚙ Настройки ленты</button></div>
<div class="wf-card wf-muted wf-pad">Лента в промпт ролевой игры не попадает. Хранится в этом чате.
<br><br><button class="wf-linkbtn" data-act="clear">Очистить Инстаграм этого чата</button></div>`;
    }

    // ---------- личные сообщения ----------

    const DM_NAMES = { reddit: 'Чат Reddit', twitter: 'Сообщения X', insta: 'Direct' };
    const dmBusy = new Set();

    function dmAttr(x) {
        return `data-act="dm" data-path="${esc(x.author)}" data-name="${esc(x.name || x.author)}" title="Написать в личку"`;
    }

    function dmList(net = netOf()) { return (feed()?.dms || []).filter(t => t.net === net); }

    function dmFind(net, handle) {
        const h = String(handle).toLowerCase();
        return (feed()?.dms || []).find(t => t.net === net && t.handle.toLowerCase() === h);
    }

    function dmOpen(handle, name) {
        const f = feed();
        if (!f) return toastr.info('Сначала открой чат.', 'Лента мира');
        const net = netOf();
        handle = isSocial(net) ? normHandle(handle) : normUser(handle);
        if (cfg().blockPlayer !== false && isPlayerNick(handle)) return toastr.info('Это твой же персонаж — себе не пишут.', 'Лента мира');
        let t = dmFind(net, handle);
        if (!t) { t = { id: uid(), net, handle, name: String(name || handle).slice(0, 50), msgs: [], unread: 0, ts: Date.now() }; f.dms.unshift(t); save(); }
        ui.dm = t.id; ui.dmView = true; ui.composing = false;
        t.unread = 0;
        render();
        setTimeout(() => $win?.find('.wf-dm-input').trigger('focus'), 30);
    }

    /** Что этот аккаунт писал в ленте — чтобы в личке он говорил своим голосом. */
    function dmVoice(t) {
        const out = [];
        const h = t.handle.toLowerCase();
        const walk = (list, where) => { for (const c of list || []) { if (String(c.author).toLowerCase() === h) out.push(`- (коммент под «${where}») ${c.body}`); walk(c.replies, where); } };
        for (const p of feed().posts.filter(x => x.net === t.net)) {
            const where = String(p.title || p.body || '').slice(0, 50);
            if (String(p.author).toLowerCase() === h) out.push(`- (пост) ${p.title ? p.title + ' — ' : ''}${String(p.body || '').slice(0, 200)}`);
            walk(p.comments, where);
        }
        return out.slice(0, 8).join('\n');
    }

    function dmPrompt(t) {
        const me = ctx().name1 || 'игрок';
        const net = { reddit: 'личный чат Reddit', twitter: 'личные сообщения Твиттера (X)', insta: 'Direct Инстаграма' }[t.net];
        const hist = t.msgs.slice(-30).map(m => `${m.from === 'me' ? me : '@' + t.handle}: ${m.text}`).join('\n');
        const voice = dmVoice(t);
        return `${worldContext({ lite: true })}

## Собеседник
${t.name} (@${t.handle}) — житель этого мира со своим характером, знаниями и интересами. Если это канонический персонаж или герой ролевой игры — он говорит в своём характере.
${voice ? `Что он публиковал в ленте (его голос и позиция):\n${voice}\n` : ''}
## Переписка (${net})
${hist}

## Задание
Ты отвечаешь ТОЛЬКО за @${t.handle}. Напиши его ответ на последние сообщения ${me}. Это личка, а не публичная лента: можно быть откровеннее, грубее, флиртовать, торговаться, врать, уходить от ответа — как этот персонаж сделал бы с этим собеседником. Стиль — живой мессенджер: 1–3 коротких сообщения подряд, без описаний действий, без ремарок, без кавычек. Не пиши за ${me}.
Ответь ТОЛЬКО JSON: {"messages":["первое сообщение","второе (если нужно)"]}`;
    }

    async function dmSend(text) {
        const t = (feed()?.dms || []).find(x => x.id === ui.dm);
        if (!t) return;
        text = String(text || '').trim();
        if (text) t.msgs.push({ from: 'me', text, ts: Date.now() });
        if (!t.msgs.length || t.msgs.at(-1).from !== 'me') return;
        t.ts = Date.now(); save();
        if (dmBusy.has(t.id)) { render(); return; }
        const chatId = ctx().getCurrentChatId?.();
        dmBusy.add(t.id); render();
        try {
            const raw = await callModel(dmSystem(t.net), dmPrompt(t), 1200, t.net);
            if (ctx().getCurrentChatId?.() !== chatId) return;
            let msgs = [];
            try { const j = parseJson(raw); msgs = Array.isArray(j) ? j : (j.messages || j.replies || []); }
            catch { msgs = [String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()]; } // модель ответила просто текстом — тоже годится
            msgs = msgs.map(m => cap(typeof m === 'string' ? m : m?.text, 600)).filter(Boolean).slice(0, 4);
            if (!msgs.length) throw new Error('пустой ответ');
            const base = Date.now();
            msgs.forEach((m, i) => t.msgs.push({ from: 'them', text: m, ts: base + i }));
            t.ts = Date.now();
            if (!(isOpen && ui.dmView && ui.dm === t.id)) { t.unread = (t.unread || 0) + msgs.length; toastr.info(esc(msgs[0]).slice(0, 120), `✉ @${t.handle}`); }
            save();
        } catch (e) {
            console.error('[world-feed] dm', e);
            toastr.error(errText(e), 'Сообщение не доставлено', { timeOut: 10000 });
        } finally { dmBusy.delete(t.id); render(); }
    }

    /** Системный промт лички: правила соцсети + запрет писать за игрока. */
    function dmSystem(net) {
        return `${styleRules(net)}\n\nСейчас ты ведёшь не ленту, а ЛИЧНУЮ переписку одного аккаунта с игроком. Отвечай только за этот аккаунт.${playerRule()}`;
    }

    function dmUnreadTotal(net = netOf()) { return dmList(net).reduce((n, t) => n + (t.unread || 0), 0); }

    function dmHtml() {
        const list = dmList().slice().sort((a, b) => b.ts - a.ts);
        const t = list.find(x => x.id === ui.dm);
        const tw = netOf();
        const listHtml = `<div class="wf-dm-list">
  <div class="wf-dm-h"><b>${DM_NAMES[tw]}</b><button class="wf-linkbtn wf-x" data-act="dmclose" title="К ленте">✕</button></div>
  <div class="wf-dm-new"><input class="wf-dm-to" placeholder="${isSocial(tw) ? '@ник' : 'u/ник'} — написать новому"><button class="wf-btn2" data-act="dmnew">→</button></div>
  ${list.map(x => `<div class="wf-dm-item ${x.id === ui.dm ? 'on' : ''}" data-act="dmgo" data-path="${x.id}">
    ${twAva(x.name || x.handle)}<div class="wf-dm-meta"><b>${esc(x.name)}</b> <span class="wf-muted">@${esc(x.handle)}</span><br>
    <small class="wf-muted">${esc(x.msgs.at(-1)?.from === 'me' ? 'Вы: ' : '')}${esc(String(x.msgs.at(-1)?.text || 'нет сообщений').slice(0, 40))}</small></div>
    ${x.unread ? `<span class="wf-dm-unread">${x.unread}</span>` : ''}</div>`).join('') || '<div class="wf-pad wf-muted">Переписок нет. Нажми на имя любого автора в ленте — или впиши ник выше.</div>'}
</div>`;
        const chatHtml = t ? `<div class="wf-dm-chat">
  <div class="wf-dm-h"><button class="wf-linkbtn wf-dm-back" data-act="dmback" title="К перепискам">←</button>${twAva(t.name || t.handle)}<div><b>${esc(t.name)}</b><br><small class="wf-muted">@${esc(t.handle)}</small></div>
    <span style="flex:1"></span><button class="wf-linkbtn" data-act="dmdel" data-path="${t.id}" title="Удалить переписку">🗑</button></div>
  <div class="wf-dm-msgs">${t.msgs.map((m, i) => `<div class="wf-dm-msg ${m.from === 'me' ? 'me' : 'them'}"><span>${twText(m.text)}</span>
    <button class="wf-dm-x" data-act="dmdelmsg" data-path="${t.id}|${i}" title="Удалить сообщение">✕</button></div>`).join('')
    || `<div class="wf-muted wf-pad">Начни разговор с @${esc(t.handle)}.</div>`}
    ${dmBusy.has(t.id) ? '<div class="wf-dm-msg them wf-typing"><span>печатает<i>.</i><i>.</i><i>.</i></span></div>' : ''}</div>
  <div class="wf-dm-send"><textarea class="wf-dm-input" rows="1" placeholder="Сообщение… (Enter — отправить, Shift+Enter — новая строка)"></textarea>
    <button class="wf-btn" data-act="dmsend">➤</button></div>
</div>` : '<div class="wf-dm-chat wf-dm-empty wf-muted">Выбери переписку слева.</div>';
        return `<div class="wf-dm ${t ? 'has-chat' : ''}">${listHtml}${chatHtml}</div>`;
    }

    /** Форма своего поста: на Реддите — по кнопке «✏ Пост», в Твиттере — всегда сверху ленты. */
    function composerHtml(all) {
        const me = esc(ctx().name1 || 'я');
        if (netOf() === 'insta') {
            if (!ui.composing) return '';
            return `<div class="wf-newpost wf-card wf-pad wf-ig-new">
<div class="wf-row"><b>Новая публикация</b><button class="wf-linkbtn wf-x" data-act="compose" title="Отмена">✕</button></div>
<label class="wf-f">Фото: загрузить своё<input type="file" accept="image/*" class="wf-new-file"></label>
<label class="wf-f">…или описать, и его проявят (лучше по-английски)<textarea class="wf-new-photo" rows="2" placeholder="Maglor on a cliff at dusk, harp on his back, wind in his hair"></textarea></label>
<label class="wf-f">Подпись<textarea class="wf-new-body" rows="3" placeholder="не спрашивайте 🌊 #Балар"></textarea></label>
<label class="wf-f">Геометка<input class="wf-new-sub" placeholder="📍 Устье Сириона"></label>
<div class="wf-row"><button class="wf-btn" data-act="publish">Поделиться</button>
<span class="wf-muted">${cfg().autoReplies !== false ? 'подписчики сразу начнут комментировать' : ''}</span></div></div>`;
        }
        if (netOf() === 'twitter') {
            return `<div class="wf-tw-compose">${twAva(ctx().name1, true)}
<div class="wf-tw-main"><textarea class="wf-tw-input" rows="2" placeholder="Что происходит, ${me}?"></textarea>
<div class="wf-row wf-tw-crow"><span class="wf-muted">Ctrl+Enter</span><span class="wf-count">280</span>
<button class="wf-btn wf-tw-btn" data-act="publish">Твитнуть</button></div></div></div>`;
        }
        if (!ui.composing) return '';
        const subs = [...new Set(all.filter(p => p.net !== 'twitter').map(p => p.sub))];
        return `<div class="wf-newpost wf-card wf-pad">
<div class="wf-row"><b>Новый пост от u/${esc(normUser(ctx().name1))}</b><button class="wf-linkbtn wf-x" data-act="compose" title="Отмена">✕</button></div>
<label class="wf-f">Сообщество<input class="wf-new-sub" list="wf_subs" placeholder="r/Beleriand" value="${esc(ui.sub || subs[0] || '')}"></label>
<datalist id="wf_subs">${subs.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
<label class="wf-f">Заголовок<input class="wf-new-title" placeholder="AITA за то, что…"></label>
<label class="wf-f">Текст (можно пусто)<textarea class="wf-new-body" rows="5" placeholder="**жирный**, *курсив*, >цитата, >!спойлер!<"></textarea></label>
<div class="wf-row"><button class="wf-btn" data-act="publish">Опубликовать</button>
<span class="wf-muted">${cfg().autoReplies !== false ? 'жители сразу начнут комментировать' : 'комменты — кнопкой в треде'}</span></div></div>`;
    }

    async function publishOwn($btn) {
        const c = ctx();
        const f = feed();
        if (!f) return toastr.info('Сначала открой чат.', 'Лента мира');
        const tw = netOf() === 'twitter';
        const $box = $btn.closest('.wf-newpost, .wf-tw-compose');
        let post;
        if (netOf() === 'insta') {
            const file = $box.find('.wf-new-file')[0]?.files?.[0];
            const desc = String($box.find('.wf-new-photo').val() || '').trim();
            if (!file && !desc) return toastr.warning('В Инстаграме без фото нельзя: загрузи или опиши его.', 'Лента мира');
            let src = '';
            if (file) {
                try {
                    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
                    src = await uploadImage(dataUrl);
                } catch (e) { return toastr.error(errText(e), 'Фото не загрузилось'); }
            }
            post = { id: uid(), net: 'insta', mine: true, author: normHandle(translit(c.name1 || 'me')), name: c.name1 || 'я', verified: false,
                location: String($box.find('.wf-new-sub').val() || '').replace(/^📍\s*/, '').trim(), sub: '', flair: '', title: '',
                body: String($box.find('.wf-new-body').val() || '').trim(), score: 0, ts: Date.now(), vote: 0,
                image: { prompt: desc || '(своё фото)', src, auto: !src }, comments: [] };
            ui.composing = false;
        } else if (tw) {
            const body = String($box.find('.wf-tw-input').val() || '').trim();
            if (!body) return;
            if (body.length > 280) return toastr.warning(`Длиннее 280 символов на ${body.length - 280}. Это Твиттер, а не летопись.`, 'Лента мира');
            post = { id: uid(), net: 'twitter', mine: true, author: normHandle(translit(c.name1 || 'me')), name: c.name1 || 'я', verified: false,
                sub: '', flair: '', title: '', body, score: 0, retweets: 0, views: 1, ts: Date.now(), vote: 0, image: null, comments: [] };
        } else {
            const title = String($box.find('.wf-new-title').val() || '').trim();
            if (!title) return toastr.warning('Нужен заголовок.', 'Лента мира');
            post = { id: uid(), net: 'reddit', mine: true, sub: normSub($box.find('.wf-new-sub').val()), author: normUser(c.name1), flair: '',
                title, body: String($box.find('.wf-new-body').val() || '').trim(), score: 1, ts: Date.now(), vote: 1, image: null, comments: [] };
            ui.composing = false;
        }
        f.posts.unshift(post);
        ui.open.add(post.id);
        save(); render();
        $win.find('.wf-feed').scrollTop(0);
        if (cfg().autoReplies !== false) moreComments(post.id);
    }

    function trendsHtml(posts) {
        const tags = {};
        for (const p of posts) for (const t of tagsOf(p.body)) tags[t] = (tags[t] || 0) + 1;
        const list = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12);
        const people = {};
        for (const p of posts) {
            if (p.mine) continue;
            (people[p.author] ??= { name: p.name || p.author, n: 0, v: p.verified }).n++;
        }
        const who = Object.entries(people).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
        return `<div class="wf-card wf-tw-card"><div class="wf-tw-card-h">Актуальные темы</div>
<div class="wf-sub-item ${ui.tag ? '' : 'on'}" data-tag="">🏠 Вся лента <span class="wf-muted">${posts.length}</span></div>
${list.map(([t, n]) => `<div class="wf-sub-item ${ui.tag === t ? 'on' : ''}" data-tag="${esc(t)}"><div><small class="wf-muted">Тренды мира</small><br><b>${esc(t)}</b></div><span class="wf-muted">${n}</span></div>`).join('') || '<div class="wf-pad wf-muted">Хэштегов пока нет.</div>'}
</div>
${who.length ? `<div class="wf-card wf-tw-card"><div class="wf-tw-card-h">Самые громкие</div>
${who.map(([h, x]) => `<div class="wf-sub-item">${twAva(x.name)}<div style="margin-left:8px"><b>${esc(x.name)}</b>${x.v ? '<span class="wf-tw-check">✓</span>' : ''}<br><small class="wf-muted">@${esc(h)}</small></div><span class="wf-muted">${x.n}</span></div>`).join('')}</div>` : ''}
<div class="wf-card wf-pad wf-muted">🔌 ${esc(connLabel())}<br><button class="wf-linkbtn wf-blue" data-act="settings">⚙ Настройки ленты</button></div>
<div class="wf-card wf-muted wf-pad">Лента — чистое развлечение: в промпт ролевой игры не попадает. Хранится в этом чате.
<br><br><button class="wf-linkbtn" data-act="clear">Очистить Твиттер этого чата</button></div>`;
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
<br><br><button class="wf-linkbtn" data-act="clear">Очистить Реддит этого чата</button></div>`;
    }

    function renderBusy() {
        if (!$win) return;
        const label = ({ twitter: 'Мир твитит…', insta: 'Мир выбирает фильтр…' })[busy] || 'Мир пишет посты…';
        $win.find('.wf-tab').each(function () { $(this).toggleClass('wf-loading', busy === this.dataset.net); });
        $win.find('.wf-refresh').prop('disabled', !!busy).html(busy ? `<span class="wf-spin"></span> ${label}` : '⟳ Обновить ленту');
    }

    function render() {
        if (!$win || !isOpen) return;
        const f = feed();
        const $feed = $win.find('.wf-feed');
        const scroll = $feed.scrollTop();
        const drafts = {};
        $win.find('.wf-reply-input').each(function () { if (this.value) drafts[this.dataset.path] = this.value; });
        const net = netOf();
        const tw = net === 'twitter', ig = net === 'insta';
        $win.toggleClass('wf-tw', tw || ig).toggleClass('wf-igm', ig);
        $win.find('[data-net]').each(function () { $(this).toggleClass('on', this.dataset.net === netOf()); });
        $win.find('.wf-logo').html(ig ? '<span class="wf-iglogo">Instagram</span>' : tw ? '<span class="wf-xlogo">𝕏</span>' : '<span class="wf-snoo">👽</span> <b>reddit</b><small>.world</small>');
        $win.find('.wf-tab[data-net="reddit"] .wf-tab-t').text(ui.sub && !tw ? `r/${ui.sub}` : 'Reddit — главная мира');
        $win.find('.wf-tab[data-net="twitter"] .wf-tab-t').text(ui.tag && tw ? `${ui.tag} — поиск / X` : 'Главная / X');
        $win.find('.wf-tab').each(function () {
            const n = this.dataset.net === netOf() ? 0 : (unseen[this.dataset.net] || 0) + dmUnreadTotal(this.dataset.net);
            $(this).find('.wf-tab-badge').text(n || '').toggle(!!n);
        });
        unseen[netOf()] = 0;
        $win.find('.wf-tab[data-net="insta"] .wf-tab-t').text(ig && ui.tag ? `${ui.tag.replace(/^@/, '')} • Instagram` : 'Instagram');
        $win.find('#wf_url_host').text(ig ? 'https://www.instagram.world/' : tw ? 'https://x.world/' : 'https://www.reddit.world/');
        $win.find('#wf_url_sub').text(ig ? (ui.tag.startsWith('@') ? ui.tag.slice(1) + '/' : ui.tag ? `explore/tags/${ui.tag.slice(1)}/` : '')
            : tw ? (ui.tag ? `search?q=${ui.tag}` : 'home') : (ui.sub ? `r/${ui.sub}/` : ''));
        $win.find('.wf-sort').html(ig ? '' : tw
            ? '<button data-sort="hot">Для вас</button><button data-sort="new">Последнее</button><button data-sort="top">Топ</button>'
            : '<button data-sort="new">🆕 Новое</button><button data-sort="hot">🔥 Горячее</button><button data-sort="top">🏆 Топ</button>');
        $win.find('[data-sort]').each(function () { $(this).toggleClass('on', this.dataset.sort === ui.sort); });
        $win.find('.wf-compose-btn').toggle(!tw).toggleClass('on', ui.composing).html(ig ? '⊕ Публикация' : '✏ Пост');
        renderBusy();
        if (!f) {
            $feed.html('<div class="wf-empty">Открой чат — у каждого чата своя лента.</div>');
            $win.find('.wf-side').empty();
            return;
        }
        const keep = {};
        $win.find('.wf-new-sub, .wf-new-title, .wf-new-body, .wf-tw-input').each(function () { keep[this.className] = this.value; });
        const posts = sorted(f.posts);
        const mine = f.posts.filter(p => p.net === netOf());
        const empty = ig ? `<div class="wf-empty">◎<br>Ни одной фотографии.<br>Нажми «Обновить ленту» — и мир начнёт выкладывать, что у вас стряслось, в лучшем свете.</div>`
            : tw
            ? `<div class="wf-empty">𝕏<br>Тишина в ленте.<br>Нажми «Обновить ленту» — и мир начнёт твитить о том, что у вас стряслось.</div>`
            : `<div class="wf-empty">👽<br>Здесь пока пусто.<br>Нажми «Обновить ленту» — и жители мира начнут обсуждать, что у вас стряслось.</div>`;
        const totalUnread = dmUnreadTotal();
        $win.find('.wf-dm-btn').toggleClass('on', !!ui.dmView).find('.wf-dm-badge').text(totalUnread || '').toggle(!!totalUnread);
        $win.find('.wf-dm-label').text(DM_NAMES[net]);
        if (ui.dmView) {
            const draft = $win.find('.wf-dm-input').val();
            $feed.html(dmHtml());
            $win.find('.wf-side').html(ig ? igSideHtml(mine) : tw ? trendsHtml(mine) : sideHtml(mine));
            $win.find('.wf-dm-input').val(draft || '');
            const box = $win.find('.wf-dm-msgs')[0]; if (box) box.scrollTop = box.scrollHeight;
            $win.find('#wf_url_sub').text(ig ? 'direct/inbox/' : tw ? 'messages' : 'chat');
            return;
        }
        $feed.html((ig ? storiesHtml(mine) : '') + composerHtml(f.posts) + (posts.length ? posts.map(ig ? igHtml : tw ? tweetHtml : postHtml).join('') : empty));
        $win.find('.wf-side').html(ig ? igSideHtml(mine) : tw ? trendsHtml(mine) : sideHtml(mine));
        if (ig) watchAutoImages();
        $win.find('.wf-reply-input').each(function () { if (drafts[this.dataset.path]) this.value = drafts[this.dataset.path]; });
        $win.find('.wf-new-sub, .wf-new-title, .wf-new-body, .wf-tw-input').each(function () { if (keep[this.className] !== undefined) this.value = keep[this.className]; });
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
            case 'dm': return dmOpen(this.dataset.path, this.dataset.name);
            case 'dmlist': ui.dmView = !ui.dmView; if (ui.dmView && !dmList().some(x => x.id === ui.dm)) ui.dm = null; render(); return;
            case 'dmback': ui.dm = null; render(); return;
            case 'dmclose': ui.dmView = false; render(); return;
            case 'dmgo': { ui.dm = path; const t = dmList().find(x => x.id === path); if (t) { t.unread = 0; save(); } render(); setTimeout(() => $win.find('.wf-dm-input').trigger('focus'), 30); return; }
            case 'dmnew': { const v = String($win.find('.wf-dm-to').val() || '').replace(/^(@|\/?u\/)/, '').trim(); if (v) dmOpen(v, v); return; }
            case 'dmsend': { const $ta = $win.find('.wf-dm-input'); const v = $ta.val(); $ta.val(''); return dmSend(v); }
            case 'dmdel': {
                const ok = await ctx().Popup.show.confirm('Удалить переписку?', '');
                if (!ok) return;
                const f = feed(); f.dms = f.dms.filter(x => x.id !== path); ui.dm = null; break;
            }
            case 'dmdelmsg': { const [id, i] = String(path).split('|'); const t = feed().dms.find(x => x.id === id); if (t) t.msgs.splice(Number(i), 1); break; }
            case 'compose':
                ui.composing = !ui.composing;
                render();
                if (ui.composing) { $win.find('.wf-feed').scrollTop(0); $win.find('.wf-new-title').trigger('focus'); }
                return;
            case 'publish': return publishOwn($(this));
            case 'rt': if (post) post.rt = !post.rt; break;
            case 'toggle': ui.open.has(post.id) ? ui.open.delete(post.id) : ui.open.add(post.id); break;
            case 'expand':
                if (ui.expanded.has(post.id) || ui.open.has(post.id)) { ui.expanded.delete(post.id); ui.open.delete(post.id); }
                else ui.expanded.add(post.id);
                break;
            case 'collapse': if (comment) comment.collapsed = !comment.collapsed; break;
            case 'award':
                if (post.net === 'insta') { toastr.info('Отправлено в директ. Прочитано, без ответа.', `@${post.author}`); return; }
                post.awards = (post.awards || 0) + 1;
                toastr.info('edit: спасибо за награду, добрый незнакомец 🏅', `u/${post.author}`);
                break;
            case 'img': return genImage(post.id);
            case 'reimg': post.image.src = ''; return genImage(post.id);
            case 'zoom': window.open(post.image.src, '_blank'); return;
            case 'more': return moreComments(post.id);
            case 'settings': return toggleSettings(true);
            case 'reply': {
                const $slot = $(this).closest('.wf-c-main, .wf-tw-main').children('.wf-reply-slot');
                if ($slot.children().length) { $slot.empty(); return; }
                $slot.html(`<div class="wf-composer sm"><textarea class="wf-reply-input" data-path="${path}" placeholder="Ответ ${isSocial(post.net) ? '@' : 'u/'}${esc(comment.author)}…"></textarea>
<button data-act="send" data-path="${path}">Ответить</button></div>`);
                $slot.find('textarea').trigger('focus');
                return;
            }
            case 'send': {
                const $ta = $(this).siblings('.wf-reply-input');
                const text = String($ta.val() || '').trim();
                if (!text) return;
                const mine = isSocial(post.net)
                    ? { id: uid(), author: normHandle(translit(ctx().name1 || 'me')), name: ctx().name1 || 'я', flair: '', body: text, score: 0, ts: Date.now(), replies: [], mine: true }
                    : { id: uid(), author: normUser(ctx().name1), flair: '', body: text, score: 1, ts: Date.now(), replies: [], mine: true };
                (comment ? comment.replies : post.comments).push(mine);
                $ta.val('');
                save(); render();
                toastr.info(isSocial(post.net) ? 'Жми «Ещё» — тебе ответят.' : 'Жми «Загрузить ещё комментарии» — тебе ответят.', 'Опубликовано', { timeOut: 3000 });
                return;
            }
            case 'delc': if (comment) parentList.splice(parentList.indexOf(comment), 1); break;
            case 'delp': {
                const ok = await ctx().Popup.show.confirm('Удалить пост?', esc(post.title || String(post.body || '').slice(0, 140)));
                if (!ok) return;
                const f = feed(); f.posts.splice(f.posts.indexOf(post), 1);
                break;
            }
            case 'clear': {
                const net = netOf();
                const ok = await ctx().Popup.show.confirm(`Очистить ${({ twitter: 'Твиттер', insta: 'Инстаграм' })[net] || 'Реддит'}?`, 'Все посты этой вкладки в этом чате будут удалены. Вторая вкладка останется.');
                if (!ok) return;
                feed().posts = feed().posts.filter(p => p.net !== net);
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
            const chars = worldContext().length, lite = worldContext({ lite: true }).length;
            const f = n => `${n.toLocaleString('ru-RU')} симв. (~${Math.round(n / 3.5).toLocaleString('ru-RU')} ток.)`;
            return `≈ ${f(chars)} на обновление ленты · ≈ ${f(lite)} + сам тред на «ещё комментарии»`;
        } catch { return ''; }
    }

    function fillSettingsPage($p) {
        const s = cfg();
        $p.html(`
<div class="wf-set">
  <div class="wf-set-back"><button class="wf-btn2">← К ленте</button></div>
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
    <div class="wf-card-h">📜 Промт Реддита</div>
    <div class="wf-pad">
      <div class="wf-hint">Что генерировать и как: кто пишет, сленг, сабреддиты, запреты. Плейсхолдеры: <code>{{user}}</code>, <code>{{char}}</code>, <code>{{language}}</code>. Формат JSON и лимиты длины расширение добавляет само — их сюда писать не нужно.</div>
      <textarea data-s="systemPrompt" class="wf-prompt" rows="14"></textarea>
      <div class="wf-row"><button class="wf-btn2" data-do="resetPrompt">Вернуть стандартный</button>
        <label class="wf-f wf-inline">Язык<input data-s="language" style="width:120px"></label></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">🐦 Промт Твиттера</div>
    <div class="wf-pad">
      <div class="wf-hint">Отдельный характер: коротко, тейки, стан-аккаунты, ратио. Те же плейсхолдеры. Лимит 280 символов и формат JSON расширение добавит само.</div>
      <textarea data-s="systemPromptTw" class="wf-prompt" rows="14"></textarea>
      <div class="wf-row"><button class="wf-btn2" data-do="resetPromptTw">Вернуть стандартный</button></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">📸 Инстаграм</div>
    <div class="wf-pad">
      <div class="wf-hint">Каждый пост — фото, его рисует расширение Hermes Images. Внешность героя игры подставляется, только если он назван в кадре; люди всегда одеты по ситуации.</div>

      <div class="wf-sub-h">✍ Модель для текста постов Инстаграма</div>
      <div class="wf-seg">
        <label><input type="radio" name="wf_igtext" value="feed"> Как у всей ленты</label>
        <label><input type="radio" name="wf_igtext" value="main"> Основное подключение чата</label>
        <label><input type="radio" name="wf_igtext" value="profile"> Профиль подключения</label>
        <label><input type="radio" name="wf_igtext" value="custom"> Свой API</label>
      </div>
      <div data-igt="profile"><label class="wf-f">Профиль из Connection Manager<select data-s="igProfileId">${profileOptions()}</select></label></div>
      <div data-igt="custom">
        <label class="wf-f">Адрес API (OpenAI-совместимый)<input data-s="igApiUrl" placeholder="https://api.example.com/v1"></label>
        <label class="wf-f">Ключ<span class="wf-keyrow"><input data-s="igApiKey" type="password" autocomplete="off" placeholder="sk-…"><button class="wf-btn2" data-do="eye" data-for="igApiKey" title="Показать">👁</button></span></label>
        <label class="wf-f">Модель<span class="wf-keyrow"><input data-s="igApiModel" list="wf_ig_models" placeholder="gemini-2.5-flash"><button class="wf-btn2" data-do="igModels">Список</button></span></label>
        <datalist id="wf_ig_models"></datalist>
        <label class="wf-f">Температура<input data-s="igTemperature" type="number" step="0.05" min="0" max="2"></label>
      </div>
      <div class="wf-row"><button class="wf-btn" data-do="igTest">Проверить текст</button><span class="wf-ig-test-out wf-muted"></span></div>

      <div class="wf-sub-h">🖼 Модель для фото Инстаграма</div>
      <div class="wf-seg">
        <label><input type="radio" name="wf_igimg" value="hermes"> Как в Hermes Images</label>
        <label><input type="radio" name="wf_igimg" value="hprofile"> Другой профиль Hermes Images</label>
        <label><input type="radio" name="wf_igimg" value="custom"> Свой адрес и модель</label>
      </div>
      <div data-igi="hprofile"><label class="wf-f">Профиль Hermes Images<select data-s="igImgProfileId" class="wf-hprof"><option value="">— загружаю… —</option></select></label></div>
      <div data-igi="custom">
        <label class="wf-f">Адрес прокси картинок<input data-s="igImgEndpoint" placeholder="https://api.closerouter.dev/v1"></label>
        <label class="wf-f">Ключ<span class="wf-keyrow"><input data-s="igImgKey" type="password" autocomplete="off" placeholder="sk-…"><button class="wf-btn2" data-do="eye" data-for="igImgKey" title="Показать">👁</button></span></label>
        <label class="wf-f">Модель<span class="wf-keyrow"><input data-s="igImgModel" list="wf_ig_imgmodels" placeholder="openai/gpt-image-1-mini"><button class="wf-btn2" data-do="igImgModels">Список</button></span></label>
        <datalist id="wf_ig_imgmodels"></datalist>
        <label class="wf-f">Качество<select data-s="igImgQuality"><option value="auto">auto</option><option value="low">low (дёшево)</option><option value="medium">medium</option><option value="high">high</option></select></label>
      </div>
      <div class="wf-row"><button class="wf-btn" data-do="igImgTest">Проверить фото-подключение</button><span class="wf-ig-img-out wf-muted"></span></div>
      <div class="wf-hint">Удобно поставить для инсты дешёвую модель или low-качество: картинок тут много, в игре — свои настройки и они не меняются.</div>

      <div class="wf-grid">
        <label class="wf-f">Рисовать самим за одно обновление (0 — только по нажатию)<input data-s="igAutoImages" type="number" min="0" max="15"></label>
      </div>
      <label class="wf-f">Стиль фото (английский)<input data-s="igStyle"></label>
      <div class="wf-row"><button class="wf-btn2" data-do="resetIgStyle">Вернуть «снято на телефон»</button></div>
      <label class="wf-f" style="margin-top:12px">Промт Инстаграма</label>
      <textarea data-s="systemPromptIg" class="wf-prompt" rows="14"></textarea>
      <div class="wf-row"><button class="wf-btn2" data-do="resetPromptIg">Вернуть стандартный</button></div>
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
      <label class="wf-f">Для «ещё комментариев»: сообщений чата (0 — только пост и тред)<input data-s="commentHistory" type="number" min="0" max="50"></label>
      <label class="wf-chk"><input type="checkbox" data-s="commentCard"> Для комментариев тоже слать карточку и персону</label>
      <label class="wf-chk wf-span"><input type="checkbox" data-s="blockPlayer"> Персонаж игрока не пишет в ленту (посты и комменты от его ников удаляются)</label>
      <label class="wf-f wf-span">Другие имена персонажа игрока, через запятую<input data-s="playerAliases" placeholder="напр.: Kano, Канафинвэ, Makalaurë"></label>
      <div class="wf-hint wf-span wf-ctx-est"></div>
    </div>
  </section>

  <section class="wf-card wf-set-card">
    <div class="wf-card-h">🧩 Прочее</div>
    <div class="wf-pad wf-grid">
      <label class="wf-chk"><input type="checkbox" data-s="showFab"> Плавающая кнопка 📰</label>
      <label class="wf-chk"><input type="checkbox" data-s="autoReplies"> На мой пост/твит сразу приходят ответы</label>
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
            else if (k === 'systemPromptTw') this.value = s.systemPromptTw || DEFAULT_TW_PROMPT;
            else if (k === 'systemPromptIg') this.value = s.systemPromptIg || DEFAULT_IG_PROMPT;
            else this.value = s[k] ?? '';
        });
        $p.find(`input[name="wf_conn"][value="${s.conn}"]`).prop('checked', true);
        $p.find(`input[name="wf_igtext"][value="${s.igTextConn}"]`).prop('checked', true);
        $p.find(`input[name="wf_igimg"][value="${s.igImgConn}"]`).prop('checked', true);
        syncConnVisibility($p);
        import(HI_BASE + 'settings.js').then(m => {
            const hc = m.getCfg(); hiCfgCache = hc;
            $p.find('.wf-hprof').html('<option value="">— выбери профиль —</option>' + (hc.profiles || [])
                .map(x => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.model || '?')}</option>`).join('')).val(s.igImgProfileId || '');
        }).catch(() => $p.find('.wf-hprof').html('<option value="">Hermes Images не установлен</option>'));
        $p.find('.wf-ctx-est').text(contextEstimate());
    }

    function syncConnVisibility($p) {
        const conn = cfg().conn;
        $p.find('[data-show]').each(function () { this.style.display = this.dataset.show === conn ? '' : 'none'; });
        $p.find('[data-igt]').each(function () { this.style.display = this.dataset.igt === cfg().igTextConn ? '' : 'none'; });
        $p.find('[data-igi]').each(function () { this.style.display = this.dataset.igi === cfg().igImgConn ? '' : 'none'; });
    }

    let estTimer = 0, purgeTimer = 0;
    function bindSettingsPage($p) {
        $p.on('input change', '[data-s]', function () {
            const s = cfg();
            const k = this.dataset.s;
            let v = this.type === 'checkbox' ? this.checked : this.type === 'number' ? Number(this.value) : this.value;
            if (k === 'systemPrompt' && String(v).trim() === DEFAULT_SYSTEM_PROMPT.trim()) v = '';
            if (k === 'systemPromptTw' && String(v).trim() === DEFAULT_TW_PROMPT.trim()) v = '';
            if (k === 'systemPromptIg' && String(v).trim() === DEFAULT_IG_PROMPT.trim()) v = ''; // стандартный = пусто, чтобы обновлялся вместе с расширением
            s[k] = v;
            ctx().saveSettingsDebounced();
            if (k === 'showFab') placeFab();
            if (k === 'blockPlayer' || k === 'playerAliases') { clearTimeout(purgeTimer); purgeTimer = setTimeout(() => { const n = purgePlayer(); if (n) toastr.info(`Убрано записей от лица персонажа игрока: ${n}`, 'Лента мира'); }, 800); }
            if (['historyMessages', 'historyMaxChars', 'includeCard', 'commentHistory', 'commentCard'].includes(k)) {
                clearTimeout(estTimer);
                estTimer = setTimeout(() => $p.find('.wf-ctx-est').text(contextEstimate()), 250);
            }
        });
        $p.on('change', 'input[name="wf_igtext"], input[name="wf_igimg"]', function () {
            cfg()[this.name === 'wf_igtext' ? 'igTextConn' : 'igImgConn'] = this.value;
            ctx().saveSettingsDebounced();
            syncConnVisibility($p);
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
                const inp = $p.find(`[data-s="${this.dataset.for || 'apiKey'}"]`)[0];
                inp.type = inp.type === 'password' ? 'text' : 'password';
            } else if (act === 'resetPrompt') {
                cfg().systemPrompt = '';
                $p.find('[data-s="systemPrompt"]').val(DEFAULT_SYSTEM_PROMPT);
                ctx().saveSettingsDebounced();
            } else if (act === 'igModels') {
                const $out = $p.find('.wf-ig-test-out').text('загружаю модели…');
                try {
                    const ids = await listCustomModels(textConn('insta'));
                    $p.find('#wf_ig_models').html(ids.map(id => `<option value="${esc(id)}">`).join(''));
                    $out.text(`моделей: ${ids.length} — начни печатать в поле «Модель»`);
                } catch (err) { $out.text('✖ ' + errText(err)); }
            } else if (act === 'igTest') {
                const $out = $p.find('.wf-ig-test-out').text('проверяю: ' + connLabel('insta') + '…');
                const btn = this; btn.disabled = true; const t0 = Date.now();
                try {
                    const r = await callModel('Ответь одним словом.', 'Скажи «работает».', 300, 'insta');
                    $out.html(`✔ ${esc(connLabel('insta'))} · ${((Date.now() - t0) / 1000).toFixed(1)} с · ответ: «${esc(String(r).trim().slice(0, 60))}»`);
                } catch (err) { $out.text('✖ ' + errText(err)); } finally { btn.disabled = false; }
            } else if (act === 'igImgModels' || act === 'igImgTest') {
                const $out = $p.find('.wf-ig-img-out').text('проверяю…');
                try {
                    const prov = await import(HI_BASE + 'provider.js');
                    const hs = await import(HI_BASE + 'settings.js');
                    const hc = imageCfg(hs.getCfg(), 'insta');
                    const r = await prov.listModels(hc);
                    if (act === 'igImgModels') $p.find('#wf_ig_imgmodels').html(r.image.map(id => `<option value="${esc(id)}">`).join(''));
                    const has = r.all.includes(hc.model);
                    $out.html(`✔ ${esc(imageLabel(hc))} · ${r.ms} мс · моделей картинок: ${r.image.length}${act === 'igImgTest' ? (has ? ' · модель найдена' : ' · <span class="wf-err">модели «' + esc(hc.model) + '» в списке нет</span>') : ''}`);
                } catch (err) {
                    $out.text('✖ ' + (err?.message || errText(err)) + (err?.status ? ` (HTTP ${err.status})` : ''));
                }
            } else if (act === 'resetPromptIg') {
                cfg().systemPromptIg = '';
                $p.find('[data-s="systemPromptIg"]').val(DEFAULT_IG_PROMPT);
                ctx().saveSettingsDebounced();
            } else if (act === 'resetIgStyle') {
                cfg().igStyle = DEFAULTS.igStyle;
                $p.find('[data-s="igStyle"]').val(DEFAULTS.igStyle);
                ctx().saveSettingsDebounced();
            } else if (act === 'resetPromptTw') {
                cfg().systemPromptTw = '';
                $p.find('[data-s="systemPromptTw"]').val(DEFAULT_TW_PROMPT);
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

    async function listCustomModels(s = textConn()) {
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
  <div class="inline-drawer-toggle inline-drawer-header"><b>📰 Лента мира (Reddit · Twitter · Instagram)</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
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
        c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { ui.open.clear(); ui.sub = ''; ui.tag = ''; ui.composing = false; ui.dmView = false; ui.dm = null; render(); });
        try {
            c.SlashCommandParser?.addCommandObject?.(c.SlashCommand.fromProps({
                name: 'feed', helpString: 'Открыть ленту мира (Reddit / Twitter).',
                callback: () => { open(); return ''; },
            }));
        } catch { /* без слэш-команды */ }
        window.WorldFeed = { purgePlayer, isPlayerNick, playerAliases, morePrompt, callModel, styleRules, worldContext, toggleSettings, openSettings, listCustomModels, DEFAULT_SYSTEM_PROMPT, DEFAULT_TW_PROMPT, DEFAULT_IG_PROMPT, dmOpen, dmSend, dmPrompt, imageCfg, textConn, igPrompt, normIg, queueDraw, tweetsPrompt, normTweet, switchNet, publishOwn, buildImagePrompt, gameImageInfo, instructionsIn, cap, postsPrompt, open, close, refreshFeed, moreComments, genImage, feed, cfg, parseJson, normPost, render };
    }

    $(init);
})();
