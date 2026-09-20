/**
 * Planner → Writer — two-stage generation for SillyTavern.
 *
 * Before every reply, the chat context is sent to a "planner" connection profile (typically a
 * large, smart model that is good at tracking people and events). The planner drafts what should
 * happen next. That plan is injected into the prompt, and the main connection (the "writer",
 * typically a local model fine-tuned for prose with its own sampler settings) writes the reply.
 *
 * Everything runs through `SillyTavern.getContext()` so the extension does not depend on
 * relative import paths into the SillyTavern source tree.
 */

const MODULE_NAME = 'planner_writer';
const INJECT_KEY = 'PLANNER_WRITER_PLAN';
const EXTRA_KEY = 'planner_writer';
const LOG = '[Planner→Writer]';
const TOAST_TITLE = 'Planner → Writer';
const VIEW_BUTTON_CLASS = 'pw_view_plan';

// Mirrors extension_prompt_types / extension_prompt_roles from SillyTavern's script.js.
const POSITION = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
const ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

// The folder name is whatever the repository was cloned as; derive it so the template resolves.
const EXTENSION_FOLDER = new URL('.', import.meta.url).pathname.split('/').filter(Boolean).pop();
const TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER}`;

const DEFAULT_PLANNER_PROMPT = `You are the story planner for an interactive fiction / roleplay session. You work behind the scenes: a separate writer model will turn your plan into prose. You do NOT write the reply yourself.

Read the character definitions and the chat transcript carefully. Track the state of the scene: where everyone is, what they know, what they want, what just happened, and which threads are unresolved. Pay close attention to {{user}}'s latest message and what it invites.

Then write a plan for {{char}}'s next reply with these sections:

1. Situation: one or two sentences on where things stand right now.
2. Beats: an ordered list of 2-5 concrete beats the reply should hit (actions, reactions, dialogue intent, reveals). Say who does what. Advance the scene; don't stall.
3. Characters: for every character who appears, their current mood, goal, and anything the writer must keep consistent (location, appearance, clothing, injuries, possessions, relationships, what they know and don't know).
4. Continuity: callbacks to earlier events worth referencing, and facts that must not be contradicted.
5. Avoid: things the reply must not do (e.g. never act or speak for {{user}}, don't resolve X yet, don't repeat the previous reply's structure).

Be specific and concrete. Keep it under 300 words. Output only the plan, with no preamble and no prose.`;

const DEFAULT_REQUEST = 'Write the plan for {{char}}\'s next reply now.';

const DEFAULT_REQUEST_CONTINUE = '{{char}}\'s last message in the transcript is unfinished. The writer will continue it from exactly where it stops. Plan what the rest of that message should contain.';

const DEFAULT_INJECT_TEMPLATE = `[Planning notes for your next reply. Follow this outline, but write it in your own words and style. Never mention or quote these notes.]
{{plan}}`;

const defaultSettings = Object.freeze({
    enabled: true,
    profileId: '',
    plannerPrompt: DEFAULT_PLANNER_PROMPT,
    plannerRequest: DEFAULT_REQUEST,
    plannerRequestContinue: DEFAULT_REQUEST_CONTINUE,
    maxTokens: 1024,
    historyMessages: 0,
    historyTokens: 0,
    historyFormat: 'transcript',
    includeCard: true,
    includePersona: true,
    includeWorldInfo: true,
    includeSummary: true,
    includeAuthorsNote: true,
    injectTemplate: DEFAULT_INJECT_TEMPLATE,
    injectPosition: POSITION.IN_CHAT,
    injectDepth: 0,
    injectRole: ROLE.SYSTEM,
    reuseOnSwipe: false,
    runOnContinue: false,
    onError: 'continue',
    showNotifications: true,
    storeOnMessage: true,
});

const state = {
    /** Plan used by the generation currently in flight; attached to the reply on MESSAGE_RECEIVED. */
    currentPlan: null,
    /** Most recent plan (mirrors chat metadata). */
    lastPlan: '',
    /** A pinned plan that the next generation uses instead of calling the planner. */
    pendingPlan: '',
    abortController: null,
    isPlanning: false,
    stoppedByUser: false,
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = {};
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = value;
        }
    }
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

/** Per-chat data lives in chat metadata so it is saved with the chat. */
function getChatData() {
    const { chatMetadata } = getContext();
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        return null;
    }
    if (!chatMetadata[MODULE_NAME] || typeof chatMetadata[MODULE_NAME] !== 'object') {
        chatMetadata[MODULE_NAME] = {};
    }
    return chatMetadata[MODULE_NAME];
}

function saveChatData() {
    const context = getContext();
    if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    } else if (typeof context.saveMetadata === 'function') {
        context.saveMetadata();
    }
}

function notify(level, message) {
    if (level !== 'error' && !getSettings().showNotifications) {
        return;
    }
    if (typeof toastr?.[level] === 'function') {
        toastr[level](message, TOAST_TITLE);
    }
}

function isTrue(value) {
    return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function errorMessage(error) {
    return error?.cause?.message || error?.message || String(error);
}

function isAbortError(error) {
    return state.stoppedByUser || error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
}

// ---------------------------------------------------------------------------------------------
// Building the planner request
// ---------------------------------------------------------------------------------------------

function messageSpeaker(message) {
    const context = getContext();
    if (message.name) {
        return message.name;
    }
    if (message.is_user) {
        return context.name1 || 'User';
    }
    if (message.extra?.type === 'narrator') {
        return 'Narrator';
    }
    return context.name2 || 'Character';
}

function formatTranscriptLine(message) {
    return `${messageSpeaker(message)}: ${String(message.mes ?? '').trim()}`;
}

async function countTokens(text) {
    try {
        return await getContext().getTokenCountAsync(text);
    } catch {
        return Math.ceil(text.length / 4);
    }
}

/**
 * Picks the most recent messages that fit the configured limits.
 * @param {object[]} messages Non-system chat messages, oldest first
 * @param {number} contextSize Writer context size, used as the default token budget
 */
async function selectHistory(messages, contextSize) {
    const settings = getSettings();
    let selected = messages.slice();

    const maxMessages = Number(settings.historyMessages) || 0;
    if (maxMessages > 0) {
        selected = selected.slice(-maxMessages);
    }

    const budget = Number(settings.historyTokens) > 0 ? Number(settings.historyTokens) : (Number(contextSize) || 0);
    if (budget > 0) {
        const kept = [];
        let used = 0;
        for (let i = selected.length - 1; i >= 0; i--) {
            const tokens = await countTokens(formatTranscriptLine(selected[i]));
            // Always keep at least the latest message.
            if (kept.length > 0 && used + tokens > budget) {
                break;
            }
            used += tokens;
            kept.unshift(selected[i]);
        }
        selected = kept;
    }

    return selected;
}

function section(title, body) {
    const text = String(body ?? '').trim();
    return text ? `## ${title}\n${text}` : '';
}

async function getWorldInfoText(messages, contextSize, fields, type) {
    const context = getContext();
    if (typeof context.getWorldInfoPrompt !== 'function') {
        return '';
    }
    try {
        // Same shape SillyTavern uses for its own scan: most recent message first, names included.
        const chatForWI = messages.map(formatTranscriptLine).reverse();
        const globalScanData = {
            personaDescription: fields.persona ?? '',
            characterDescription: fields.description ?? '',
            characterPersonality: fields.personality ?? '',
            characterDepthPrompt: fields.charDepthPrompt ?? '',
            scenario: fields.scenario ?? '',
            creatorNotes: fields.creatorNotes ?? '',
            trigger: ['normal', 'continue', 'swipe', 'regenerate'].includes(type) ? type : 'normal',
        };
        // Dry run: no events are emitted and no timed effects (sticky/cooldown) are touched.
        const result = await context.getWorldInfoPrompt(chatForWI, contextSize, true, globalScanData);
        const parts = [result?.worldInfoBefore, result?.worldInfoAfter];
        for (const depthEntry of result?.worldInfoDepth ?? []) {
            parts.push(...(depthEntry?.entries ?? []));
        }
        return parts.filter(part => typeof part === 'string' && part.trim()).join('\n');
    } catch (error) {
        console.warn(LOG, 'World info scan failed, continuing without it', error);
        return '';
    }
}

async function buildContextSections(messages, contextSize, type) {
    const context = getContext();
    const settings = getSettings();
    const sections = [];

    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() ?? {};
    } catch (error) {
        console.warn(LOG, 'Could not read character card fields', error);
    }

    if (settings.includeCard) {
        const group = context.groupId ? context.groups?.find(g => g.id === context.groupId) : null;
        if (group) {
            const members = (group.members ?? [])
                .map(avatar => context.characters?.find(c => c.avatar === avatar)?.name)
                .filter(Boolean);
            sections.push(section('Characters in this group chat', members.join(', ')));
        }
        const card = [
            fields.description,
            fields.personality ? `Personality: ${fields.personality}` : '',
        ].filter(Boolean).join('\n\n');
        sections.push(section(group ? 'Character definitions' : `Character definition (${context.name2})`, card));
        sections.push(section('Scenario', fields.scenario));
    }
    if (settings.includePersona) {
        sections.push(section(`${context.name1}'s persona (the user)`, fields.persona));
    }
    if (settings.includeWorldInfo) {
        sections.push(section('World info / lore (active entries)', await getWorldInfoText(messages, contextSize, fields, type)));
    }
    if (settings.includeSummary) {
        sections.push(section('Summary of earlier events', context.extensionPrompts?.['1_memory']?.value));
    }
    if (settings.includeAuthorsNote) {
        sections.push(section('Author\'s note', context.extensionPrompts?.['2_floating_prompt']?.value));
    }

    return sections.filter(Boolean).join('\n\n');
}

/**
 * Builds the chat-completion style message list sent to the planner.
 * @param {object[]} chatMessages Chat messages (the interceptor's copy, or the live chat)
 * @param {number} contextSize Writer context size
 * @param {string} type Generation type
 * @param {string} [extraGuidance] One-off guidance (from /plan)
 */
async function buildPlannerMessages(chatMessages, contextSize, type, extraGuidance = '') {
    const context = getContext();
    const settings = getSettings();
    const sub = text => context.substituteParams(String(text ?? ''));

    const allMessages = (chatMessages ?? []).filter(message => message && !message.is_system);
    const history = await selectHistory(allMessages, contextSize);
    const contextBlock = await buildContextSections(allMessages, contextSize, type);

    const guidance = getChatData()?.guidance;
    const request = [
        sub(type === 'continue' ? settings.plannerRequestContinue : settings.plannerRequest),
        guidance ? `Guidance from the user for this plan:\n${sub(guidance)}` : '',
        extraGuidance ? `Additional guidance for this plan:\n${sub(extraGuidance)}` : '',
    ].filter(part => part && part.trim()).join('\n\n');

    const messages = [
        { role: 'system', content: [sub(settings.plannerPrompt), contextBlock].filter(part => part && part.trim()).join('\n\n') },
    ];

    if (settings.historyFormat === 'messages') {
        for (const message of history) {
            messages.push({ role: message.is_user ? 'user' : 'assistant', content: formatTranscriptLine(message) });
        }
        messages.push({ role: 'user', content: request });
    } else {
        const transcript = history.map(formatTranscriptLine).join('\n\n');
        const scope = history.length < allMessages.length ? ` (last ${history.length} of ${allMessages.length} messages)` : '';
        messages.push({
            role: 'user',
            content: `## Chat transcript${scope}, oldest to newest\n${transcript || '(no messages yet)'}\n\n${request}`,
        });
    }

    return messages;
}

// ---------------------------------------------------------------------------------------------
// Talking to the planner
// ---------------------------------------------------------------------------------------------

function extractContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result && typeof result === 'object') {
        return String(result.content ?? '');
    }
    return '';
}

async function sendToPlanner(messages, signal) {
    const context = getContext();
    const settings = getSettings();
    const maxTokens = Math.max(1, Number(settings.maxTokens) || 1024);

    if (settings.profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service?.sendRequest) {
            throw new Error('This SillyTavern version does not expose ConnectionManagerRequestService. Please update SillyTavern.');
        }
        const result = await service.sendRequest(settings.profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
        return extractContent(result);
    }

    // No planner profile selected: fall back to the current connection, i.e. the writer plans for itself.
    const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const prompt = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
    const result = await context.generateRaw({ prompt, systemPrompt, responseLength: maxTokens });
    return extractContent(result);
}

function cleanPlan(raw) {
    let text = String(raw ?? '');
    try {
        const parsed = getContext().parseReasoningFromString?.(text, { strict: false });
        if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
            text = parsed.content;
        }
    } catch {
        // Reasoning parsing is best-effort.
    }
    text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    return text.trim();
}

function rememberPlan(plan, { persist = false } = {}) {
    state.lastPlan = plan;
    const data = getChatData();
    if (data) {
        data.lastPlan = plan;
        if (persist) {
            saveChatData();
        }
    }
    updatePlanUi();
}

/**
 * Runs the planner and returns the cleaned plan text.
 * @param {object[]} chatMessages Chat messages
 * @param {number} contextSize Writer context size
 * @param {string} type Generation type
 * @param {string} [extraGuidance] One-off guidance
 * @param {boolean} [persist] Save the plan to chat metadata immediately
 */
async function runPlanner(chatMessages, contextSize, type, extraGuidance = '', persist = false) {
    if (state.isPlanning) {
        throw new Error('The planner is already running.');
    }
    const settings = getSettings();
    const messages = await buildPlannerMessages(chatMessages, contextSize, type, extraGuidance);

    state.abortController = new AbortController();
    state.isPlanning = true;
    state.stoppedByUser = false;
    const toast = settings.showNotifications && typeof toastr?.info === 'function'
        ? toastr.info('Drafting a plan for the next reply…', TOAST_TITLE, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false })
        : null;
    setPlanningUi(true);

    try {
        console.debug(LOG, 'Planner request', messages);
        const raw = await sendToPlanner(messages, state.abortController.signal);
        const plan = cleanPlan(raw);
        console.debug(LOG, 'Planner response', plan);
        if (!plan) {
            throw new Error('The planner returned an empty response.');
        }
        rememberPlan(plan, { persist });
        return plan;
    } finally {
        state.isPlanning = false;
        state.abortController = null;
        if (toast) {
            toastr.clear(toast);
        }
        setPlanningUi(false);
    }
}

async function runStandalonePlanner(extraGuidance = '') {
    const context = getContext();
    if (context.characterId === undefined && !context.groupId) {
        notify('warning', 'Open a chat first.');
        return '';
    }
    try {
        return await runPlanner(context.chat ?? [], Number(context.maxContext) || 0, 'normal', extraGuidance, true);
    } catch (error) {
        if (isAbortError(error)) {
            return '';
        }
        console.error(LOG, 'Planner failed', error);
        notify('error', `Planner failed: ${errorMessage(error)}`);
        return '';
    }
}

// ---------------------------------------------------------------------------------------------
// Injecting the plan into the writer prompt
// ---------------------------------------------------------------------------------------------

function renderInjection(plan) {
    const context = getContext();
    const template = String(getSettings().injectTemplate ?? '');
    if (!template.includes('{{plan}}')) {
        return `${context.substituteParams(template)}\n${plan}`.trim();
    }
    // Substitute macros in the template only, never inside the plan itself.
    return template.split('{{plan}}').map(part => context.substituteParams(part)).join(plan).trim();
}

function applyPlan(plan, source, type) {
    const context = getContext();
    const settings = getSettings();
    context.setExtensionPrompt(
        INJECT_KEY,
        renderInjection(plan),
        Number(settings.injectPosition),
        Math.max(0, Number(settings.injectDepth) || 0),
        false,
        Number(settings.injectRole) || ROLE.SYSTEM,
    );
    state.currentPlan = { plan, source, type, profile: settings.profileId || '', date: Date.now() };
    state.lastPlan = plan;
    updatePlanUi();
}

function clearInjection() {
    try {
        getContext().setExtensionPrompt(INJECT_KEY, '', POSITION.IN_CHAT, 0, false, ROLE.SYSTEM);
    } catch {
        // Not initialised yet.
    }
}

function findReusablePlan() {
    const chat = getContext().chat ?? [];
    const last = chat[chat.length - 1];
    const stored = last && !last.is_user ? last.extra?.[EXTRA_KEY]?.plan : '';
    return stored || getChatData()?.lastPlan || state.lastPlan || '';
}

function setPendingPlan(plan) {
    state.pendingPlan = String(plan ?? '').trim();
    updatePendingUi();
}

// ---------------------------------------------------------------------------------------------
// Generation interceptor (declared in manifest.json as "generate_interceptor")
// ---------------------------------------------------------------------------------------------

globalThis.plannerWriterInterceptor = async function plannerWriterInterceptor(chat, contextSize, abort, type) {
    // Always start clean so a stale plan can never leak into a prompt.
    clearInjection();
    state.currentPlan = null;

    const settings = getSettings();
    const generationType = type || 'normal';
    if (!settings.enabled) {
        return;
    }
    if (generationType === 'quiet' || generationType === 'impersonate') {
        return;
    }
    if (generationType === 'continue' && !settings.runOnContinue) {
        return;
    }

    let plan = '';
    let source = 'planner';

    if (state.pendingPlan) {
        plan = state.pendingPlan;
        source = 'manual';
        setPendingPlan('');
    } else if (settings.reuseOnSwipe && (generationType === 'swipe' || generationType === 'regenerate')) {
        plan = findReusablePlan();
        source = 'reused';
    }

    if (!plan) {
        try {
            plan = await runPlanner(chat, contextSize, generationType);
            source = 'planner';
        } catch (error) {
            if (isAbortError(error)) {
                console.log(LOG, 'Planner cancelled, aborting generation');
                abort(true);
                return;
            }
            console.error(LOG, 'Planner failed', error);
            if (settings.onError === 'abort') {
                notify('error', `Planner failed, generation aborted: ${errorMessage(error)}`);
                abort(true);
            } else {
                notify('warning', `Planner failed, writing without a plan: ${errorMessage(error)}`);
            }
            return;
        }
    }

    applyPlan(plan, source, generationType);
};

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const NON_GENERATED_MESSAGE_TYPES = ['command', 'extension', 'first_message'];

function onMessageReceived(messageId, type) {
    if (!state.currentPlan) {
        return;
    }
    // Messages inserted by slash commands, other extensions or greetings were not written from the plan.
    if (NON_GENERATED_MESSAGE_TYPES.includes(String(type))) {
        return;
    }
    const record = state.currentPlan;
    // One-shot: the plan belongs to exactly this reply.
    state.currentPlan = null;

    if (!getSettings().storeOnMessage) {
        return;
    }
    const message = getContext().chat?.[messageId];
    if (!message || message.is_user) {
        return;
    }
    message.extra = message.extra || {};
    message.extra[EXTRA_KEY] = { ...record };

    // Keep the plan with its swipe so it survives swiping back and forth.
    const swipeId = Number(message.swipe_id ?? 0);
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra = swipeInfo.extra || {};
        swipeInfo.extra[EXTRA_KEY] = { ...record };
    }
}

function onGenerationEnded() {
    // Note: with streaming, SillyTavern emits GENERATION_ENDED *before* MESSAGE_RECEIVED, so the
    // current plan is not cleared here; it is consumed by onMessageReceived or reset by the next
    // interceptor run / chat change.
    clearInjection();
    refreshMessageButtons();
}

function onGenerationStarted(type, _params, dryRun) {
    if (dryRun) {
        return;
    }
    // Any real generation, including ones the interceptor skips, invalidates a leftover plan.
    state.currentPlan = null;
}

function onGenerationStopped() {
    if (state.abortController) {
        state.stoppedByUser = true;
        state.abortController.abort(new DOMException('Planner stopped by user', 'AbortError'));
    }
}

function onChatChanged() {
    clearInjection();
    state.currentPlan = null;
    state.pendingPlan = '';
    state.lastPlan = getChatData()?.lastPlan || '';
    updatePlanUi();
    updatePendingUi();
    loadGuidanceUi();
    refreshMessageButtons();
}

// ---------------------------------------------------------------------------------------------
// Per-message plan viewer
// ---------------------------------------------------------------------------------------------

function refreshMessageButtons() {
    const chat = getContext().chat ?? [];
    $('#chat .mes').each(function () {
        const $mes = $(this);
        const id = Number($mes.attr('mesid'));
        const hasPlan = Boolean(chat[id]?.extra?.[EXTRA_KEY]?.plan);
        const $existing = $mes.find(`.${VIEW_BUTTON_CLASS}`);
        if (!hasPlan) {
            $existing.remove();
            return;
        }
        if ($existing.length) {
            return;
        }
        const $target = $mes.find('.extraMesButtons');
        if ($target.length) {
            $target.prepend(`<div class="mes_button ${VIEW_BUTTON_CLASS} fa-solid fa-clipboard-list" title="View the plan this reply was written from"></div>`);
        }
    });
}

function getProfileName(profileId) {
    if (!profileId) {
        return '';
    }
    try {
        return getContext().extensionSettings?.connectionManager?.profiles?.find(p => p.id === profileId)?.name ?? '';
    } catch {
        return '';
    }
}

async function showPlanPopup(messageId) {
    const context = getContext();
    const record = context.chat?.[messageId]?.extra?.[EXTRA_KEY];
    if (!record?.plan) {
        return;
    }

    const sourceLabel = {
        planner: 'Drafted by the planner',
        manual: 'Set manually',
        reused: 'Reused from the previous attempt',
    }[record.source] ?? '';
    const profileName = getProfileName(record.profile);

    const container = document.createElement('div');
    container.classList.add('pw_plan_popup');
    const header = document.createElement('div');
    header.classList.add('pw_plan_popup_header');
    header.textContent = [
        `Plan for message #${messageId}`,
        sourceLabel,
        profileName ? `Profile: ${profileName}` : '',
        record.date ? new Date(record.date).toLocaleString() : '',
    ].filter(Boolean).join(' · ');
    const body = document.createElement('div');
    body.classList.add('pw_plan_popup_body');
    body.textContent = record.plan;
    container.append(header, body);

    await context.callGenericPopup(container, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: 'Close',
    });
}

// ---------------------------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------------------------

function updatePlanUi() {
    const $plan = $('#pw_plan');
    if ($plan.length && !$plan.is(':focus')) {
        $plan.val(state.lastPlan);
    }
}

function updatePendingUi() {
    $('#pw_pending_status').toggle(Boolean(state.pendingPlan));
}

function setPlanningUi(isPlanning) {
    $('#pw_generate').toggleClass('disabled', isPlanning);
    $('#pw_planning_indicator').toggle(isPlanning);
}

function loadGuidanceUi() {
    $('#pw_guidance').val(getChatData()?.guidance ?? '');
}

const PROFILE_GROUP_LABELS = { openai: 'Chat Completion', textgenerationwebui: 'Text Completion' };

/**
 * Renders the planner profile dropdown from the Connection Manager's profiles.
 * (SillyTavern's shared dropdown helper drops profiles created after page load when it starts
 * out empty, so the extension keeps its own list and re-renders on profile events.)
 */
function renderProfileDropdown() {
    const context = getContext();
    const settings = getSettings();
    const $select = $('#pw_profile');
    if (!$select.length) {
        return;
    }

    const service = context.ConnectionManagerRequestService;
    const profiles = context.extensionSettings?.connectionManager?.profiles ?? [];
    const groups = {};
    for (const profile of profiles) {
        let supported = true;
        try {
            supported = typeof service?.isProfileSupported === 'function' ? service.isProfileSupported(profile) : Boolean(profile?.api);
        } catch {
            supported = false;
        }
        if (!supported) {
            continue;
        }
        const apiType = context.CONNECT_API_MAP?.[profile.api]?.selected ?? 'other';
        (groups[apiType] ??= []).push(profile);
    }

    $select.empty();
    $select.append($('<option>').val('').text('— Current connection (the writer plans for itself) —'));
    for (const [apiType, list] of Object.entries(groups)) {
        const $group = $('<optgroup>').attr('label', PROFILE_GROUP_LABELS[apiType] ?? apiType);
        for (const profile of list.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
            $group.append($('<option>').val(profile.id).text(profile.name));
        }
        $select.append($group);
    }

    const stillExists = profiles.some(profile => profile.id === settings.profileId);
    if (settings.profileId && !stillExists) {
        settings.profileId = '';
        saveSettings();
    }
    $select.val(settings.profileId || '');
}

function setupProfileDropdown() {
    const context = getContext();
    const settings = getSettings();
    const disabled = Boolean(context.extensionSettings?.disabledExtensions?.includes('connection-manager'));

    if (!context.ConnectionManagerRequestService?.sendRequest || disabled) {
        $('#pw_profile').prop('disabled', true);
        $('#pw_profile_warning').show();
        return;
    }

    renderProfileDropdown();
    $('#pw_profile').on('change', function () {
        settings.profileId = String($(this).val() ?? '');
        saveSettings();
    });

    const { eventSource, eventTypes } = context;
    for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (eventTypes[name]) {
            eventSource.on(eventTypes[name], () => renderProfileDropdown());
        }
    }
}

async function addSettingsUi() {
    const context = getContext();
    const settings = getSettings();
    const html = await context.renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);

    $('#pw_profile_warning, #pw_pending_status, #pw_planning_indicator').hide();

    const bindings = [
        ['#pw_enabled', 'enabled', 'checkbox'],
        ['#pw_max_tokens', 'maxTokens', 'number'],
        ['#pw_planner_prompt', 'plannerPrompt', 'text'],
        ['#pw_request', 'plannerRequest', 'text'],
        ['#pw_request_continue', 'plannerRequestContinue', 'text'],
        ['#pw_include_card', 'includeCard', 'checkbox'],
        ['#pw_include_persona', 'includePersona', 'checkbox'],
        ['#pw_include_wi', 'includeWorldInfo', 'checkbox'],
        ['#pw_include_summary', 'includeSummary', 'checkbox'],
        ['#pw_include_an', 'includeAuthorsNote', 'checkbox'],
        ['#pw_history_format', 'historyFormat', 'text'],
        ['#pw_history_messages', 'historyMessages', 'number'],
        ['#pw_history_tokens', 'historyTokens', 'number'],
        ['#pw_inject_template', 'injectTemplate', 'text'],
        ['#pw_inject_position', 'injectPosition', 'number'],
        ['#pw_inject_depth', 'injectDepth', 'number'],
        ['#pw_inject_role', 'injectRole', 'number'],
        ['#pw_reuse_on_swipe', 'reuseOnSwipe', 'checkbox'],
        ['#pw_run_on_continue', 'runOnContinue', 'checkbox'],
        ['#pw_on_error', 'onError', 'text'],
        ['#pw_notifications', 'showNotifications', 'checkbox'],
        ['#pw_store_on_message', 'storeOnMessage', 'checkbox'],
    ];

    for (const [selector, key, kind] of bindings) {
        const $el = $(selector);
        if (!$el.length) {
            console.warn(LOG, 'Missing settings element', selector);
            continue;
        }
        if (kind === 'checkbox') {
            $el.prop('checked', Boolean(settings[key]));
            $el.on('change', () => {
                settings[key] = $el.prop('checked');
                saveSettings();
            });
        } else if (kind === 'number') {
            $el.val(String(settings[key]));
            $el.on('input change', () => {
                settings[key] = Number($el.val());
                saveSettings();
            });
        } else {
            $el.val(String(settings[key] ?? ''));
            $el.on('input change', () => {
                settings[key] = String($el.val());
                saveSettings();
            });
        }
    }

    $('#pw_restore_prompts').on('click', () => {
        settings.plannerPrompt = DEFAULT_PLANNER_PROMPT;
        settings.plannerRequest = DEFAULT_REQUEST;
        settings.plannerRequestContinue = DEFAULT_REQUEST_CONTINUE;
        settings.injectTemplate = DEFAULT_INJECT_TEMPLATE;
        $('#pw_planner_prompt').val(DEFAULT_PLANNER_PROMPT);
        $('#pw_request').val(DEFAULT_REQUEST);
        $('#pw_request_continue').val(DEFAULT_REQUEST_CONTINUE);
        $('#pw_inject_template').val(DEFAULT_INJECT_TEMPLATE);
        saveSettings();
        notify('info', 'Default prompts restored.');
    });

    $('#pw_guidance').on('input', function () {
        const data = getChatData();
        if (data) {
            data.guidance = String($(this).val());
            saveChatData();
        }
    });

    $('#pw_plan').on('input', function () {
        state.lastPlan = String($(this).val());
        const data = getChatData();
        if (data) {
            data.lastPlan = state.lastPlan;
            saveChatData();
        }
    });

    $('#pw_generate').on('click', async () => {
        if (state.isPlanning) {
            return;
        }
        const plan = await runStandalonePlanner();
        if (plan) {
            notify('success', 'Plan drafted. Pin it with "Use for next reply" or just send a message to draft a fresh one.');
        }
    });

    $('#pw_use_next').on('click', () => {
        const plan = String($('#pw_plan').val()).trim();
        if (!plan) {
            notify('warning', 'There is no plan to pin. Draft one first or type your own.');
            return;
        }
        setPendingPlan(plan);
        notify('info', 'Plan pinned for the next reply.');
    });

    $('#pw_clear').on('click', () => {
        state.lastPlan = '';
        setPendingPlan('');
        const data = getChatData();
        if (data) {
            data.lastPlan = '';
            saveChatData();
        }
        $('#pw_plan').val('');
    });
}

// ---------------------------------------------------------------------------------------------
// Slash commands and macros
// ---------------------------------------------------------------------------------------------

function registerSlashCommands() {
    const context = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn(LOG, 'Slash command API not available; skipping command registration');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'plan',
        returns: 'the drafted plan',
        helpString: `
            <div>Runs the planner on the current chat and returns the plan without generating a reply.</div>
            <div>Pass <code>use=true</code> to pin the plan so the next reply uses it instead of calling the planner again. Any unnamed text is passed to the planner as one-off guidance.</div>
            <div>Example: <code>/plan use=true The stranger reveals the letter | /echo</code></div>
        `,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'use',
                description: 'pin the plan for the next reply',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: ['true', 'false'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'optional one-off guidance for the planner',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        callback: async (args, value) => {
            const plan = await runStandalonePlanner(String(value ?? ''));
            if (plan && isTrue(args?.use)) {
                setPendingPlan(plan);
            }
            return plan;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'plan-set',
        returns: 'the pinned plan',
        helpString: '<div>Pins your own plan for the next reply. The planner is skipped for that reply.</div><div>Example: <code>/plan-set {{char}} finally admits the truth, then storms out.</code></div>',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'the plan text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: async (_args, value) => {
            const plan = String(value ?? '').trim();
            if (!plan) {
                notify('warning', 'No plan text given.');
                return '';
            }
            setPendingPlan(plan);
            rememberPlan(plan, { persist: true });
            return plan;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'plan-clear',
        helpString: '<div>Unpins any plan pinned for the next reply.</div>',
        callback: async () => {
            setPendingPlan('');
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'planner',
        returns: 'the current state (on/off)',
        helpString: '<div>Turns the planner on or off, or toggles it when no argument is given. Returns the resulting state.</div>',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'on, off, or toggle',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: ['on', 'off', 'toggle'],
            }),
        ],
        callback: async (_args, value) => {
            const settings = getSettings();
            const arg = String(value ?? '').trim().toLowerCase();
            if (arg === 'on' || arg === 'true') {
                settings.enabled = true;
            } else if (arg === 'off' || arg === 'false') {
                settings.enabled = false;
            } else {
                settings.enabled = !settings.enabled;
            }
            $('#pw_enabled').prop('checked', settings.enabled);
            saveSettings();
            return settings.enabled ? 'on' : 'off';
        },
    }));
}

function registerMacros() {
    const context = getContext();
    const handler = () => state.lastPlan || '';
    const description = 'The most recent plan drafted by Planner → Writer';
    try {
        if (typeof context.macros?.registry?.registerMacro === 'function') {
            context.macros.registry.registerMacro('lastPlan', { handler, description });
        } else if (typeof context.registerMacro === 'function') {
            context.registerMacro('lastPlan', handler, description);
        }
    } catch (error) {
        console.warn(LOG, 'Could not register the {{lastPlan}} macro', error);
    }
}

function bindEvents() {
    const { eventSource, eventTypes } = getContext();
    const on = (name, handler) => {
        if (eventTypes[name]) {
            eventSource.on(eventTypes[name], handler);
        } else {
            console.warn(LOG, 'Unknown event type', name);
        }
    };

    // The prompt has been built at this point, so the injection has done its job.
    on('GENERATION_STARTED', onGenerationStarted);
    on('GENERATE_AFTER_DATA', () => clearInjection());
    on('MESSAGE_RECEIVED', onMessageReceived);
    on('GENERATION_ENDED', onGenerationEnded);
    on('GENERATION_STOPPED', onGenerationStopped);
    on('CHAT_CHANGED', onChatChanged);
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        on(name, () => refreshMessageButtons());
    }

    $(document).on('click', `.${VIEW_BUTTON_CLASS}`, function () {
        const messageId = Number($(this).closest('.mes').attr('mesid'));
        showPlanPopup(messageId);
    });
}

// ---------------------------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------------------------

jQuery(async () => {
    try {
        await addSettingsUi();
        setupProfileDropdown();
        registerSlashCommands();
        registerMacros();
        bindEvents();
        onChatChanged();
        console.log(LOG, 'Loaded');
    } catch (error) {
        console.error(LOG, 'Failed to initialise', error);
    }
});
