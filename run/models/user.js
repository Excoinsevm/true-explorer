'use strict';
const {
  Model, Sequelize
} = require('sequelize');
const { sanitize } = require('../lib/utils');
const { trigger } = require('../lib/pusher');
const { Workspace } = require('./index');

const Op = Sequelize.Op;

module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      User.hasMany(models.Workspace, { foreignKey: 'userId', as: 'workspaces' });
      User.hasOne(models.Workspace, { foreignKey: 'id', sourceKey: 'currentWorkspaceId', as: 'currentWorkspace' });
      User.hasMany(models.Explorer, { foreignKey: 'userId', as: 'explorers' });
    }

    static findByAuthId(firebaseUserId) {
        return User.findOne({
            where: {
                firebaseUserId: firebaseUserId
            },
            include: ['workspaces', 'currentWorkspace']
        });
    }

    static findByApiKey(apiKey) {
        return User.findOne({
            where: {
                apiKey: apiKey
            },
            include: ['workspaces', 'currentWorkspace']
        });
    }

    static findByStripeCustomerId(stripeCustomerId) {
        return User.findOne({
            where: {
                stripeCustomerId: stripeCustomerId
            },
            include: ['workspaces', 'currentWorkspace']
        });
    }

    static findByAuthIdWithWorkspace(firebaseUserId, workspaceName) {
        const Workspace = sequelize.models.Workspace;
        return User.findOne({
            where: {
                firebaseUserId: firebaseUserId
            },
            include: [
                {
                    model: Workspace,
                    as: 'workspaces',
                    where: {
                        name: workspaceName
                    }
                },
                'currentWorkspace'
            ]
        });
    }

    static async safeCreate(firebaseUserId, email, apiKey, stripeCustomerId, plan, explorerSubscriptionId, transaction) {
        if (!firebaseUserId || !email || !apiKey || !stripeCustomerId || !plan) throw '[User.createUser] Missing parameter';
        
        const existingUser = await User.findOne({
            where: {
                [Op.or]: [
                    { firebaseUserId: firebaseUserId },
                    { email: email }
                ]
            }
        })

        if (existingUser)
            return;

        return User.create(sanitize({
            firebaseUserId: firebaseUserId,
            email: email,
            apiKey: apiKey,
            stripeCustomerId: stripeCustomerId,
            plan: plan,
            explorerSubscriptionId: explorerSubscriptionId
        }));
    }

    safeCreateWorkspace(data) {
        return this.createWorkspace(sanitize({
            name: data.name,
            public: data.public,
            chain: data.chain,
            networkId: data.networkId,
            rpcServer: data.rpcServer,
            defaultAccount: data.settings && data.settings.defaultAccount,
            gasLimit: data.settings && data.settings.gasLimit,
            gasPrice: data.settings && data.settings.gasPrice,
            apiEnabled: data.integrations && data.integrations.indexOf('api') > -1,
            alchemyIntegrationEnabled: data.integrations && data.integrations.indexOf('alchemy') > -1
        }));
    }
  }
  User.init({
    firebaseUserId: DataTypes.STRING,
    email: DataTypes.STRING,
    apiKey: DataTypes.STRING,
    currentWorkspaceId: DataTypes.INTEGER,
    plan: DataTypes.STRING,
    stripeCustomerId: DataTypes.STRING,
    explorerSubscriptionId: DataTypes.STRING,
    isPremium: {
        type: DataTypes.VIRTUAL,
        get() {
            return this.getDataValue('plan') == 'premium';
        }
    }
  }, {
    hooks: {
        afterUpdate(user, options) {
            trigger(`private-cache-users;id=${user.id}`, 'updated', user);
        }
    },
    sequelize,
    modelName: 'User',
    tableName: 'users'
  });
  return User;
};