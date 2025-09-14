const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

class Database {
  constructor() {
    this.db = null;
    this.initialize();
  }

  async initialize() {
    const adapter = new JSONFile('db.json');
    this.db = new Low(adapter, { 
      users: [], 
      calls: [],
      groups: []
    });
    
    await this.db.read();
    this.db.data ||= { users: [], calls: [], groups: [] };
    await this.db.write();
  }

  // مدیریت کاربران
  async getUser(userId) {
    await this.db.read();
    return this.db.data.users.find(u => u.userId === userId);
  }

  async addUser(userData) {
    await this.db.read();
    const existingUser = this.db.data.users.find(u => u.userId === userData.userId);
    
    if (existingUser) {
      Object.assign(existingUser, userData);
    } else {
      this.db.data.users.push(userData);
    }
    
    await this.db.write();
    return userData;
  }

  async updateUser(userId, updates) {
    await this.db.read();
    const user = this.db.data.users.find(u => u.userId === userId);
    
    if (user) {
      Object.assign(user, updates);
      await this.db.write();
    }
    
    return user;
  }

  // مدیریت تماس‌ها
  async getCall(callId) {
    await this.db.read();
    return this.db.data.calls.find(c => c.callId === callId);
  }

  async addCall(callData) {
    await this.db.read();
    this.db.data.calls.push(callData);
    await this.db.write();
    return callData;
  }

  async updateCall(callId, updates) {
    await this.db.read();
    const call = this.db.data.calls.find(c => c.callId === callId);
    
    if (call) {
      Object.assign(call, updates);
      await this.db.write();
    }
    
    return call;
  }

  async deleteCall(callId) {
    await this.db.read();
    this.db.data.calls = this.db.data.calls.filter(c => c.callId !== callId);
    await this.db.write();
  }

  // مدیریت گروه‌ها
  async getGroup(groupId) {
    await this.db.read();
    return this.db.data.groups.find(g => g.groupId === groupId);
  }

  async addGroup(groupData) {
    await this.db.read();
    const existingGroup = this.db.data.groups.find(g => g.groupId === groupData.groupId);
    
    if (existingGroup) {
      Object.assign(existingGroup, groupData);
    } else {
      this.db.data.groups.push(groupData);
    }
    
    await this.db.write();
    return groupData;
  }

  async getGroupsForUser(userId) {
    await this.db.read();
    return this.db.data.groups.filter(g => g.members.includes(userId));
  }
}

module.exports = new Database();