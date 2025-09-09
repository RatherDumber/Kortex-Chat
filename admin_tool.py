#!/usr/bin/env python3
"""
Admin Menu CLI for the chat app.

Run this in a separate terminal after starting index.js:
  python3 admin_tool.py

Features:
- Loads /workspaces/codespaces-blank/data.json and autosaves every 1s when dirty.
- Creates timestamped backups before destructive changes.
- Temporarily disables a "shield" flag in data.meta so other processes can detect admin override.
- Thread-safe operations and atomic file writes.
"""
import json
import os
import time
import shutil
import threading
import re
from datetime import datetime

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data.json')
BACKUP_DIR = os.path.join(os.path.dirname(__file__), 'backups')
AUTOSAVE_INTERVAL = 1.0  # seconds

# State
data_lock = threading.RLock()
_dirty = False
_data = {}
_stop_event = threading.Event()

# Helpers
def load_data():
    global _data, _dirty
    if not os.path.exists(DATA_PATH):
        # initialize default structure and write immediately
        _data = {"users": [], "chats": [], "contactRequests": [], "meta": {"lastModified": int(time.time() * 1000)}}
        try:
            atomic_write(DATA_PATH, _data)
        except Exception as e:
            print("Warning: could not write initial data.json:", e)
        _dirty = False
        return
    try:
        with open(DATA_PATH, 'r', encoding='utf-8') as f:
            _data = json.load(f)
    except Exception as e:
        print("Failed to load data.json:", e)
        _data = {"users": [], "chats": [], "contactRequests": [], "meta": {"lastModified": int(time.time() * 1000)}}
    _dirty = False

def atomic_write(path, obj):
    # Ensure directory exists
    d = os.path.dirname(path)
    if d and not os.path.exists(d):
        os.makedirs(d, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def save_data(force=False):
    global _dirty
    with data_lock:
        if not force and not _dirty:
            return
        try:
            # update lastModified
            _data.setdefault('meta', {})['lastModified'] = int(time.time() * 1000)
            atomic_write(DATA_PATH, _data)
            _dirty = False
        except Exception as e:
            print("Error saving data.json:", e)

def autosave_loop():
    while not _stop_event.wait(AUTOSAVE_INTERVAL):
        with data_lock:
            if _dirty:
                save_data()

def mark_dirty():
    global _dirty
    with data_lock:
        _dirty = True

def backup_data(note=''):
    # ensure data exists on disk first
    if not os.path.exists(DATA_PATH):
        try:
            save_data(force=True)
        except Exception:
            pass
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    bak_name = f"data.json.bak.{ts}"
    bak_path = os.path.join(BACKUP_DIR, bak_name)
    try:
        shutil.copy2(DATA_PATH, bak_path)
        if note:
            with open(bak_path + '.note.txt', 'w', encoding='utf-8') as nf:
                nf.write(note)
        print(f"Backup written: {bak_path}")
    except Exception as e:
        print("Backup failed:", e)

# Shield context manager: writes shield flags immediately and restores previous meta on exit
class ShieldDisabled:
    def __init__(self, actor='admin_tool'):
        self.actor = actor
        self._previous_meta = None

    def __enter__(self):
        with data_lock:
            meta = _data.setdefault('meta', {})
            # keep a shallow copy to restore non-shield keys
            self._previous_meta = dict(meta)
            meta['shield_disabled'] = True
            meta['shield_disabled_by'] = self.actor
            meta['shield_disabled_at'] = int(time.time() * 1000)
            mark_dirty()
            save_data(force=True)  # flush immediately so other processes see it
        return self

    def __exit__(self, exc_type, exc, tb):
        with data_lock:
            meta = _data.setdefault('meta', {})
            # remove our shield keys
            for k in ('shield_disabled', 'shield_disabled_by', 'shield_disabled_at'):
                meta.pop(k, None)
            # restore other previous keys (but don't overwrite new unrelated keys)
            if isinstance(self._previous_meta, dict):
                for k, v in self._previous_meta.items():
                    if k not in ('shield_disabled', 'shield_disabled_by', 'shield_disabled_at'):
                        meta[k] = v
            meta['lastModified'] = int(time.time() * 1000)
            mark_dirty()
            save_data(force=True)

# Data utilities
def list_users():
    with data_lock:
        for u in _data.get('users', []):
            print(f"- {u.get('username')} (id={u.get('id')}, contact={u.get('contactNumber')})")

def find_user(username):
    with data_lock:
        return next((u for u in _data.get('users', []) if u.get('username') == username), None)

def delete_user(username):
    u = find_user(username)
    if not u:
        print("User not found.")
        return
    confirm = input(f"Confirm delete user '{username}' and all related chats/requests? (yes/NO): ").strip().lower()
    if confirm != 'yes':
        print("Aborted.")
        return
    backup_data(note=f"Deleting user {username}")
    with ShieldDisabled(actor='admin_tool'):
        with data_lock:
            # remove user
            before_users = len(_data.get('users', []))
            _data['users'] = [x for x in _data.get('users', []) if x.get('username') != username]
            removed_users = before_users - len(_data['users'])
            # remove contact requests involving user
            before_reqs = len(_data.get('contactRequests', []))
            _data['contactRequests'] = [r for r in _data.get('contactRequests', []) if r.get('from') != username and r.get('to') != username]
            removed_reqs = before_reqs - len(_data['contactRequests'])
            # remove chats where user participates
            before_chats = len(_data.get('chats', []))
            removed_chats_list = [c for c in _data.get('chats', []) if username in c.get('participants', [])]
            _data['chats'] = [c for c in _data.get('chats', []) if username not in c.get('participants', [])]
            removed_chats = before_chats - len(_data['chats'])
            _data.setdefault('meta', {})['lastModified'] = int(time.time() * 1000)
            mark_dirty()
        print(f"Deleted user '{username}': removed_users={removed_users}, removed_chats={removed_chats}, removed_reqs={removed_reqs}")

def list_chats():
    with data_lock:
        for c in _data.get('chats', []):
            cid = c.get('id')
            typ = c.get('type')
            parts = ','.join(c.get('participants', []))
            lm = '-'
            if c.get('updatedAt'):
                try:
                    lm = datetime.utcfromtimestamp(c.get('updatedAt')/1000).isoformat()
                except Exception:
                    lm = str(c.get('updatedAt'))
            print(f"- {cid} [{typ}] participants=({parts}) updatedAt={lm}")

def delete_chat(chat_id):
    with data_lock:
        chat = next((c for c in _data.get('chats', []) if c.get('id') == chat_id), None)
    if not chat:
        print("Chat not found.")
        return
    confirm = input(f"Confirm delete chat '{chat_id}'? (yes/NO): ").strip().lower()
    if confirm != 'yes':
        print("Aborted.")
        return
    backup_data(note=f"Deleting chat {chat_id}")
    with ShieldDisabled(actor='admin_tool'):
        with data_lock:
            before_chats = len(_data.get('chats', []))
            _data['chats'] = [c for c in _data.get('chats', []) if c.get('id') != chat_id]
            removed = before_chats - len(_data['chats'])
            _data.setdefault('meta', {})['lastModified'] = int(time.time() * 1000)
            mark_dirty()
        print(f"Deleted chat '{chat_id}'. removed={removed}")

def change_username(old, new):
    if not re.match(r'^[A-Za-z0-9_\-\.]{1,64}$', new):
        print("New username contains invalid characters or length.")
        return
    if find_user(new):
        print("Target username already exists.")
        return
    u = find_user(old)
    if not u:
        print("User not found.")
        return
    confirm = input(f"Change username '{old}' -> '{new}' ? (yes/NO): ").strip().lower()
    if confirm != 'yes':
        print("Aborted.")
        return
    backup_data(note=f"Renaming {old} -> {new}")
    with ShieldDisabled(actor='admin_tool'):
        with data_lock:
            # update user
            u['username'] = new
            # update chats participants and inbox ids
            for c in _data.get('chats', []):
                parts = c.get('participants', [])
                updated = False
                for i, p in enumerate(parts):
                    if p == old:
                        parts[i] = new
                        updated = True
                if updated:
                    if c.get('type') == 'inbox' and c.get('id') == f"inbox-{old}":
                        c['id'] = f"inbox-{new}"
            # update messages senders
            for c in _data.get('chats', []):
                for m in c.get('messages', []):
                    if m.get('sender') == old:
                        m['sender'] = new
            # update contact requests
            for r in _data.get('contactRequests', []):
                if r.get('from') == old:
                    r['from'] = new
                if r.get('to') == old:
                    r['to'] = new
            _data.setdefault('meta', {})['lastModified'] = int(time.time() * 1000)
            mark_dirty()
        print(f"Renamed '{old}' to '{new}'.")

def change_contact_number(username, new_contact):
    if not re.match(r'^C-\d{6}$', new_contact):
        print("Contact number must be in format C-123456")
        return
    u = find_user(username)
    if not u:
        print("User not found.")
        return
    with data_lock:
        for other in _data.get('users', []):
            if other is not u and other.get('contactNumber') == new_contact:
                print("Contact number already in use.")
                return
    confirm = input(f"Change contact number for '{username}' -> '{new_contact}' ? (yes/NO): ").strip().lower()
    if confirm != 'yes':
        print("Aborted.")
        return
    backup_data(note=f"Changing contact number for {username} -> {new_contact}")
    with ShieldDisabled(actor='admin_tool'):
        with data_lock:
            u['contactNumber'] = new_contact
            _data.setdefault('meta', {})['lastModified'] = int(time.time() * 1000)
            mark_dirty()
        print(f"Updated contact for '{username}' to '{new_contact}'.")

def show_menu():
    print("\nAdmin Menu")
    print("1) List users")
    print("2) Delete user")
    print("3) Change username")
    print("4) Change contact number")
    print("5) List chats")
    print("6) Delete chat")
    print("7) Backup current data.json")
    print("9) Save now")
    print("0) Exit")

def main_loop():
    load_data()
    t = threading.Thread(target=autosave_loop, daemon=True)
    t.start()
    print("Admin tool started. Editing:", DATA_PATH)
    try:
        while True:
            show_menu()
            choice = input("Select> ").strip()
            if choice == '1':
                list_users()
            elif choice == '2':
                name = input("Username to delete: ").strip()
                if name:
                    delete_user(name)
            elif choice == '3':
                old = input("Old username: ").strip()
                new = input("New username: ").strip()
                if old and new:
                    change_username(old, new)
            elif choice == '4':
                user = input("Username: ").strip()
                newc = input("New contact number (e.g., C-123456): ").strip()
                if user and newc:
                    change_contact_number(user, newc)
            elif choice == '5':
                list_chats()
            elif choice == '6':
                cid = input("Chat ID to delete: ").strip()
                if cid:
                    delete_chat(cid)
            elif choice == '7':
                backup_data(note='manual backup')
            elif choice == '9':
                print("Forcing save...")
                with data_lock:
                    save_data(force=True)
            elif choice == '0':
                print("Exiting. Final save...")
                _stop_event.set()
                with data_lock:
                    save_data(force=True)
                break
            else:
                print("Unknown option.")
            time.sleep(0.05)
    except (KeyboardInterrupt, EOFError):
        print("\nInterrupted. Saving and exiting...")
        _stop_event.set()
        with data_lock:
            save_data(force=True)

if __name__ == '__main__':
    main_loop()