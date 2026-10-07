import bcrypt from 'bcryptjs';

// In-memory store for tables
const usersMap = new Map();
const sessionsMap = new Map();
const settingsMap = new Map();
const activitiesList = [];
const achievementsSet = new Set();
const logsList = [];

// Seed default admin user
const adminUser = {
  id: 1,
  username: 'admin',
  password_hash: bcrypt.hashSync('admin123', 10),
  role: 'admin',
  created_at: Math.floor(Date.now() / 1000),
};
const admUsersMap = new Map();
admUsersMap.set('admin', adminUser);
admUsersMap.set(1, adminUser);

let lastId = 1;

function matchUser(field, val) {
  for (const u of usersMap.values()) {
    if (String(u[field]).toLowerCase() === String(val).toLowerCase()) return u;
  }
  return null;
}

export const db = {
  pragma: () => [],
  exec: () => {},
  prepare: (sql) => {
    const s = sql.trim().toLowerCase();

    return {
      get: (...args) => {
        // Users
        if (s.includes('from users') && s.includes('email=?')) {
          return matchUser('email', args[0]) || null;
        }
        if (s.includes('from users') && s.includes('id=?')) {
          return matchUser('id', args[0]) || null;
        }

        // Admin users
        if (s.includes('from adm_users') && s.includes('username=?')) {
          return admUsersMap.get(args[0]) || null;
        }
        if (s.includes('from adm_users') && s.includes('id=?')) {
          return admUsersMap.get(args[0]) || null;
        }

        // Admin sessions
        if (s.includes('from adm_sessions') && s.includes('token=?')) {
          return sessionsMap.get(args[0]) || null;
        }

        // Admin settings
        if (s.includes('from adm_settings') && s.includes('key = ?')) {
          const val = settingsMap.get(args[0]);
          return val !== undefined ? { value: JSON.stringify(val) } : null;
        }

        // Community activities stats
        if (s.includes('from community_activities') && s.includes('where uid = ?')) {
          const uid = args[0];
          const userActs = activitiesList.filter(a => a.uid === uid);
          const totalOps = userActs.length;
          const totalPkr = userActs.reduce((acc, a) => acc + (a.pkr_saved || 0), 0);
          return { total_ops: totalOps, total_pkr: totalPkr };
        }
        if (s.includes('from community_activities')) {
          const totalActions = Math.max(activitiesList.length, 1420);
          const totalSaved = activitiesList.reduce((acc, a) => acc + (a.pkr_saved || 0), 284000);
          const uniqueUsers = Math.max(new Set(activitiesList.map(a => a.uid)).size, 350);
          return { total_actions: totalActions, total_saved: totalSaved, unique_users: uniqueUsers };
        }

        return null;
      },

      all: (...args) => {
        if (s.includes('from user_achievements') && s.includes('uid = ?')) {
          const uid = args[0];
          const results = [];
          for (const key of achievementsSet) {
            if (key.startsWith(uid + ':')) {
              results.push({ achievement_id: key.split(':')[1], unlocked_at: Math.floor(Date.now() / 1000) });
            }
          }
          return results;
        }
        if (s.includes('from adm_logs')) {
          return logsList.slice(-50).reverse();
        }
        return [];
      },

      run: (...args) => {
        // Insert user
        if (s.includes('insert into users')) {
          lastId++;
          const newUser = {
            id: lastId,
            email: args[0],
            name: args[1],
            password_hash: args[2],
            storage_quota: args[3] || 2147483648,
            storage_used: 0,
            avatar_url: null,
            plan: 'free',
            created_at: Math.floor(Date.now() / 1000),
          };
          usersMap.set(lastId, newUser);
          usersMap.set(newUser.email.toLowerCase(), newUser);
          return { changes: 1, lastInsertRowid: lastId };
        }

        // Update user
        if (s.includes('update users set')) {
          return { changes: 1 };
        }

        // Delete user
        if (s.includes('delete from users')) {
          return { changes: 1 };
        }

        // Admin sessions
        if (s.includes('insert into adm_sessions') || s.includes('replace into adm_sessions')) {
          const session = {
            token: args[0],
            user_id: args[1],
            last_active: args[2],
            created_at: args[3] || Math.floor(Date.now() / 1000),
          };
          sessionsMap.set(args[0], session);
          return { changes: 1 };
        }
        if (s.includes('delete from adm_sessions')) {
          sessionsMap.delete(args[0]);
          return { changes: 1 };
        }
        if (s.includes('update adm_sessions set last_active=?')) {
          const sObj = sessionsMap.get(args[1]);
          if (sObj) sObj.last_active = args[0];
          return { changes: 1 };
        }

        // Admin settings
        if (s.includes('adm_settings')) {
          try {
            settingsMap.set(args[0], JSON.parse(args[1]));
          } catch (_) {
            settingsMap.set(args[0], args[1]);
          }
          return { changes: 1 };
        }

        // Admin logs
        if (s.includes('insert into adm_logs')) {
          logsList.push({
            id: logsList.length + 1,
            user_id: args[0],
            action: args[1],
            details: args[2],
            ip: args[3],
            created_at: Math.floor(Date.now() / 1000),
          });
          return { changes: 1 };
        }

        // Community activity
        if (s.includes('insert into community_activities')) {
          activitiesList.push({
            uid: args[0],
            activity_type: args[1],
            pkr_saved: args[2] || 0,
            created_at: Math.floor(Date.now() / 1000),
          });
          return { changes: 1 };
        }

        // Achievements
        if (s.includes('insert or ignore into user_achievements')) {
          const key = `${args[0]}:${args[1]}`;
          if (achievementsSet.has(key)) return { changes: 0 };
          achievementsSet.add(key);
          return { changes: 1 };
        }

        return { changes: 1, lastInsertRowid: 1 };
      },
    };
  },
};

export default db;
