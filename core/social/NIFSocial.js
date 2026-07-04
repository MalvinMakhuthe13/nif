/**
 * NIFSocial — Real Social Layer for the NIF Platform
 * © Fumoca Technologies · fumoca.co.za
 *
 * Usage:
 *   import { createClient } from '@supabase/supabase-js';
 *   const sb = createClient(SB_URL, SB_KEY);
 *   const social = new NIFSocial(sb, session.user.id);
 */

// ─── Reaction types ────────────────────────────────────────────────────────────
export const REACTION = Object.freeze({
  MIND_BLOWN:  '🤯',
  LOVE:        '❤️',
  WOW:         '✦',
  LAUGH:       '😂',
  CRY:         '🥲',
  FIRE:        '🔥',
  CLAP:        '👏',
});

// ─── NIFSocial client ──────────────────────────────────────────────────────────
export class NIFSocial {
  /**
   * @param {object} supabaseClient  — initialised Supabase JS client
   * @param {string} currentUserId   — auth.users.id of current session
   */
  constructor(supabaseClient, currentUserId=null) {
    this._sb        = supabaseClient;
    this._userId    = currentUserId;
    this._subs      = [];   // Realtime subscriptions to clean up
    this._listeners = {};   // event → [callbacks]
    this._presence  = null; // Presence channel for co-viewing
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  destroy() {
    this._subs.forEach(s => s.unsubscribe?.());
    this._presence?.unsubscribe?.();
    this._subs = [];
    this._listeners = {};
  }

  on(event, cb) {
    (this._listeners[event] = this._listeners[event]??[]).push(cb);
    return () => { this._listeners[event]=this._listeners[event].filter(f=>f!==cb); };
  }

  _emit(event, data) {
    (this._listeners[event]??[]).forEach(cb => cb(data));
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  async getProfile(userId=null) {
    const id = userId ?? this._userId;
    if (!id) return null;
    const { data } = await this._sb.from('profiles').select('*').eq('id',id).single();
    return data;
  }

  async updateProfile(updates) {
    if (!this._userId) return;
    await this._sb.from('profiles').update(updates).eq('id', this._userId);
  }

  async getProfileByUsername(username) {
    const { data } = await this._sb.from('profiles').select('*').eq('username',username).single();
    return data;
  }

  // ── Follow system ──────────────────────────────────────────────────────────
  async follow(targetUserId) {
    if (!this._userId || targetUserId===this._userId) return;
    await this._sb.from('follows').upsert({
      follower_id: this._userId,
      following_id: targetUserId,
    }, { onConflict:'follower_id,following_id' });
    this._emit('follow', { targetUserId });
  }

  async unfollow(targetUserId) {
    if (!this._userId) return;
    await this._sb.from('follows')
      .delete()
      .eq('follower_id', this._userId)
      .eq('following_id', targetUserId);
  }

  async isFollowing(targetUserId) {
    if (!this._userId) return false;
    const { data } = await this._sb.from('follows')
      .select('id').eq('follower_id',this._userId).eq('following_id',targetUserId).maybeSingle();
    return !!data;
  }

  async getFollowers(userId=null, { limit=50, offset=0 }={}) {
    const id = userId ?? this._userId;
    const { data } = await this._sb.from('follows')
      .select('follower_id, profiles!follows_follower_id_fkey(id,username,avatar_url,display_name)')
      .eq('following_id', id).range(offset, offset+limit-1);
    return data ?? [];
  }

  async getFollowing(userId=null, { limit=50, offset=0 }={}) {
    const id = userId ?? this._userId;
    const { data } = await this._sb.from('follows')
      .select('following_id, profiles!follows_following_id_fkey(id,username,avatar_url,display_name)')
      .eq('follower_id', id).range(offset, offset+limit-1);
    return data ?? [];
  }

  // ── NIF Feed ───────────────────────────────────────────────────────────────
  // Returns NIFs from people the user follows, sorted by recency
  async getFeed({ limit=20, cursor=null }={}) {
    if (!this._userId) return [];
    let q = this._sb.from('nif_feed')
      .select('*')
      .eq('viewer_id', this._userId)
      .order('created_at', { ascending:false })
      .limit(limit);
    if (cursor) q = q.lt('created_at', cursor);
    const { data } = await q;
    return data ?? [];
  }

  // Returns trending NIFs (most reactions in last 48h)
  async getTrending({ limit=20, vertical=null }={}) {
    let q = this._sb.from('nif_trending').select('*').limit(limit);
    if (vertical) q = q.eq('vertical', vertical);
    const { data } = await q;
    return data ?? [];
  }

  // ── Reactions — moment-anchored ────────────────────────────────────────────
  // React to a specific timestamp in a NIF (not just the whole file)
  async react(nifId, reactionType, opts={}) {
    if (!this._userId) return;
    const { timestamp=null, positionX=null, positionY=null, positionZ=null } = opts;

    // Optimistic update
    this._emit('reaction', {
      nifId, reactionType, userId:this._userId, timestamp, optimistic:true
    });

    const { data } = await this._sb.from('nif_reactions').upsert({
      nif_id:      nifId,
      user_id:     this._userId,
      reaction:    reactionType,
      moment_time: timestamp,    // null = reaction to whole NIF
      position_x:  positionX,
      position_y:  positionY,
      position_z:  positionZ,
    }, { onConflict:'nif_id,user_id,reaction' });

    return data;
  }

  async unreact(nifId, reactionType) {
    if (!this._userId) return;
    await this._sb.from('nif_reactions')
      .delete()
      .eq('nif_id', nifId)
      .eq('user_id', this._userId)
      .eq('reaction', reactionType);
  }

  // Get reaction summary for a NIF
  async getReactions(nifId) {
    const { data } = await this._sb
      .from('nif_reactions')
      .select('reaction, moment_time, position_x, position_y, position_z')
      .eq('nif_id', nifId);
    // Group by reaction type
    const summary = {};
    for (const r of (data??[])) {
      summary[r.reaction] = (summary[r.reaction]??0)+1;
    }
    return { reactions: data??[], summary };
  }

  // Get reactions clustered by moment (for highlights surfacing)
  async getMomentHighlights(nifId) {
    const { data } = await this._sb
      .from('nif_moment_highlights')
      .select('*')
      .eq('nif_id', nifId)
      .order('reaction_count', { ascending:false })
      .limit(20);
    return data ?? [];
  }

  // ── Spatial comments ────────────────────────────────────────────────────────
  // Comments anchored to timestamp + position (click on scene, add note)
  async addComment(nifId, text, opts={}) {
    if (!this._userId || !text.trim()) return;
    const { timestamp=null, posX=null, posY=null, posZ=null, parentId=null } = opts;
    const { data } = await this._sb.from('nif_comments').insert({
      nif_id:    nifId,
      user_id:   this._userId,
      text:      text.trim(),
      moment_time: timestamp,
      position_x:  posX,
      position_y:  posY,
      position_z:  posZ,
      parent_id:   parentId,
    }).select('*, profiles(username,avatar_url,display_name)').single();
    this._emit('comment', data);
    return data;
  }

  async getComments(nifId, { timestamp=null, radius=2 }={}) {
    let q = this._sb.from('nif_comments')
      .select('*, profiles(username,avatar_url,display_name)')
      .eq('nif_id', nifId)
      .is('parent_id', null)
      .order('created_at', { ascending:true });
    const { data } = await q;
    return data ?? [];
  }

  async deleteComment(commentId) {
    if (!this._userId) return;
    await this._sb.from('nif_comments')
      .delete().eq('id', commentId).eq('user_id', this._userId);
  }

  // ── Live viewer presence ────────────────────────────────────────────────────
  // When multiple people view the same NIF simultaneously, they can see each other
  joinPresence(nifId, opts={}) {
    const channel = this._sb.channel(`nif:${nifId}`, {
      config:{ presence:{ key: this._userId??'anon' } }
    });

    const userMeta = {
      userId:   this._userId,
      username: opts.username ?? 'Anonymous',
      avatar:   opts.avatar   ?? null,
      joinedAt: Date.now(),
      playhead: 0,
    };

    channel
      .on('presence', { event:'sync' }, () => {
        const state = channel.presenceState();
        const viewers = Object.values(state).flat();
        this._emit('viewers', viewers);
      })
      .on('presence', { event:'join' }, ({ newPresences }) => {
        this._emit('viewer_join', newPresences);
      })
      .on('presence', { event:'leave' }, ({ leftPresences }) => {
        this._emit('viewer_leave', leftPresences);
      })
      // Co-view events: one user scrubs → others see it (opt-in only)
      .on('broadcast', { event:'playhead_sync' }, ({ payload }) => {
        this._emit('remote_playhead', payload);
      })
      .on('broadcast', { event:'reaction_burst' }, ({ payload }) => {
        this._emit('reaction_burst', payload);
      })
      .subscribe(async status => {
        if (status==='SUBSCRIBED') {
          await channel.track(userMeta);
        }
      });

    this._presence = channel;

    return {
      // Update your playhead so co-viewers can optionally sync to you
      updatePlayhead: (t) => {
        userMeta.playhead = t;
        channel.track(userMeta);
      },
      // Broadcast a playhead sync invitation (co-viewer clicks "watch together")
      syncPlayhead: (t) => {
        channel.send({ type:'broadcast', event:'playhead_sync', payload:{ t, from:this._userId } });
      },
      // Send a live reaction burst (emoji floats up on all viewers' screens)
      burstReaction: (reactionType) => {
        channel.send({ type:'broadcast', event:'reaction_burst', payload:{ reactionType, from:this._userId } });
      },
      leave: () => { channel.unsubscribe(); this._presence=null; },
    };
  }

  // ── Live reaction stream ───────────────────────────────────────────────────
  // Subscribe to reactions on a NIF in real time (for the viewer overlay)
  subscribeToReactions(nifId, callback) {
    const sub = this._sb.channel(`reactions:${nifId}`)
      .on('postgres_changes', {
        event:'INSERT', schema:'public', table:'nif_reactions', filter:`nif_id=eq.${nifId}`
      }, payload => {
        callback(payload.new);
        this._emit('reaction', payload.new);
      })
      .subscribe();
    this._subs.push(sub);
    return () => sub.unsubscribe();
  }

  // Subscribe to comments on a NIF in real time
  subscribeToComments(nifId, callback) {
    const sub = this._sb.channel(`comments:${nifId}`)
      .on('postgres_changes', {
        event:'*', schema:'public', table:'nif_comments', filter:`nif_id=eq.${nifId}`
      }, payload => {
        callback(payload);
        this._emit('comment_change', payload);
      })
      .subscribe();
    this._subs.push(sub);
    return () => sub.unsubscribe();
  }

  // ── NIF Fork / Remix ────────────────────────────────────────────────────────
  async forkNIF(nifId, newTitle) {
    if (!this._userId) return null;
    const { data } = await this._sb.rpc('fork_nif', {
      source_nif_id: nifId,
      new_title:     newTitle,
      new_owner_id:  this._userId,
    });
    return data;
  }

  // ── Collections / Playlists ────────────────────────────────────────────────
  async createCollection(name, description='') {
    if (!this._userId) return;
    const { data } = await this._sb.from('nif_collections').insert({
      user_id:name, name, description
    }).select().single();
    return data;
  }

  async addToCollection(collectionId, nifId) {
    await this._sb.from('nif_collection_items').upsert({
      collection_id: collectionId, nif_id: nifId
    }, { onConflict:'collection_id,nif_id' });
  }

  async getCollections(userId=null) {
    const { data } = await this._sb.from('nif_collections')
      .select('*, nif_collection_items(count)')
      .eq('user_id', userId??this._userId);
    return data ?? [];
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  async getNotifications({ limit=20, unreadOnly=false }={}) {
    let q = this._sb.from('nif_notifications')
      .select('*')
      .eq('user_id', this._userId)
      .order('created_at', { ascending:false })
      .limit(limit);
    if (unreadOnly) q = q.eq('read', false);
    const { data } = await q;
    return data ?? [];
  }

  async markNotificationsRead() {
    await this._sb.from('nif_notifications')
      .update({ read:true })
      .eq('user_id', this._userId).eq('read', false);
  }

  subscribeToNotifications(callback) {
    if (!this._userId) return ()=>{};
    const sub = this._sb.channel(`notifications:${this._userId}`)
      .on('postgres_changes', {
        event:'INSERT', schema:'public', table:'nif_notifications',
        filter:`user_id=eq.${this._userId}`
      }, payload => callback(payload.new))
      .subscribe();
    this._subs.push(sub);
    return () => sub.unsubscribe();
  }

  // ── Public profile page data ───────────────────────────────────────────────
  async getPublicProfile(username) {
    const { data:profile } = await this._sb.from('profiles')
      .select('*').eq('username',username).single();
    if (!profile) return null;
    const { data:nifs } = await this._sb.from('nif_files')
      .select('id,title,vertical,thumbnail_url,view_count,created_at,gaussian_count')
      .eq('user_id',profile.id).eq('is_public',true)
      .order('created_at',{ascending:false}).limit(20);
    const { count:followerCount } = await this._sb.from('follows')
      .select('*',{count:'exact',head:true}).eq('following_id',profile.id);
    const { count:followingCount } = await this._sb.from('follows')
      .select('*',{count:'exact',head:true}).eq('follower_id',profile.id);
    const isFollowing = this._userId
      ? await this.isFollowing(profile.id)
      : false;
    return { profile, nifs:nifs??[], followerCount, followingCount, isFollowing };
  }
}

// ─── Social UI components (vanilla JS, no framework) ──────────────────────────
// Drop these into any HTML page that needs social features

export class ReactionBar {
  /**
   * Renders floating emoji reactions on top of the NIF viewer.
   * @param {HTMLElement} container
   * @param {NIFSocial}   social
   * @param {string}      nifId
   */
  constructor(container, social, nifId) {
    this.container = container;
    this.social    = social;
    this.nifId     = nifId;
    this._el       = null;
    this._build();

    // Listen for live reactions from other viewers
    social.subscribeToReactions(nifId, (r) => this._burst(r.reaction));
    social.on('reaction_burst', ({reactionType}) => this._burst(reactionType));
  }

  _build() {
    this._el = document.createElement('div');
    this._el.style.cssText = `
      position:absolute;bottom:80px;left:50%;transform:translateX(-50%);
      display:flex;gap:6px;z-index:20;pointer-events:auto;
    `;
    Object.entries(REACTION).forEach(([key, emoji]) => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.title = key.replace(/_/g,' ');
      btn.style.cssText = `
        width:36px;height:36px;border-radius:50%;border:0.5px solid rgba(255,255,255,0.15);
        background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);cursor:pointer;font-size:16px;
        transition:transform 0.12s;display:flex;align-items:center;justify-content:center;
      `;
      btn.addEventListener('mouseenter', () => btn.style.transform='scale(1.2)');
      btn.addEventListener('mouseleave', () => btn.style.transform='scale(1)');
      btn.addEventListener('click', () => {
        this.social.react(this.nifId, emoji, { timestamp: null });
        this._burst(emoji);
      });
      this._el.appendChild(btn);
    });
    this.container.appendChild(this._el);
  }

  _burst(emoji) {
    // Float emoji up the screen and fade out
    const span    = document.createElement('span');
    span.textContent = emoji;
    span.style.cssText = `
      position:absolute;
      left:${20+Math.random()*60}%;
      bottom:120px;
      font-size:${24+Math.random()*12}px;
      pointer-events:none;
      z-index:25;
      animation:nif-reaction-float 2.2s ease-out forwards;
    `;
    this.container.appendChild(span);
    setTimeout(() => span.remove(), 2300);
  }

  mount() {
    if (!document.getElementById('nif-reaction-keyframes')) {
      const s = document.createElement('style');
      s.id = 'nif-reaction-keyframes';
      s.textContent = `
        @keyframes nif-reaction-float {
          0%   { opacity:1; transform:translateY(0)   scale(1); }
          80%  { opacity:0.8; }
          100% { opacity:0; transform:translateY(-160px) scale(0.7); }
        }
      `;
      document.head.appendChild(s);
    }
    return this;
  }

  destroy() { this._el?.remove(); }
}

export class ViewerPresenceBar {
  /**
   * Shows live viewer count and avatars for co-viewers.
   * @param {HTMLElement} container
   * @param {NIFSocial}   social
   * @param {string}      nifId
   */
  constructor(container, social, nifId) {
    this._el = document.createElement('div');
    this._el.style.cssText = `
      position:absolute;top:14px;right:14px;
      display:flex;align-items:center;gap:6px;
      background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);
      border:0.5px solid rgba(255,255,255,0.12);border-radius:8px;
      padding:5px 10px;z-index:20;font-size:11px;font-family:Syne,sans-serif;
    `;
    container.appendChild(this._el);

    social.on('viewers', (viewers) => {
      const n = viewers.length;
      this._el.innerHTML = `
        <span style="width:7px;height:7px;border-radius:50%;background:#3ddc97;flex-shrink:0"></span>
        <span style="color:#fff;font-weight:600">${n}</span>
        <span style="color:rgba(255,255,255,0.45)">${n===1?'viewer':'viewers'}</span>
      `;
    });
  }

  destroy() { this._el?.remove(); }
}
