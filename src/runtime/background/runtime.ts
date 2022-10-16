// 脚本运行时,主要负责脚本的加载和匹配
// 油猴脚本将监听页面的创建,将代码注入到页面中
import MessageSandbox from "@App/app/message/sandbox";
import LoggerCore from "@App/app/logger/core";
import Logger from "@App/app/logger/logger";
import {
  Script,
  SCRIPT_STATUS_ENABLE,
  SCRIPT_TYPE_NORMAL,
  ScriptDAO,
  ScriptRunResouce,
} from "@App/app/repo/scripts";
import ResourceManager from "@App/app/service/resource/manager";
import ValueManager from "@App/app/service/value/manager";
import { dealScript, randomString } from "@App/utils/utils";
import { UrlInclude, UrlMatch } from "@App/utils/match";
import { MessageHander, MessageSender } from "@App/app/message/message";
import ScriptManager from "@App/app/service/script/manager";
import { Channel } from "@App/app/message/channel";
import IoC from "@App/app/ioc";
import { compileScriptCode } from "../content/utils";
import GMApi, { Request } from "./gm_api";
import { genScriptMenu } from "./utils";

export type ScriptMenuItem = {
  id: number;
  name: string;
  accessKey: string;
  sender: MessageSender;
  channelFlag: string;
};

export type ScriptMenu = {
  id: number;
  name: string;
  enable: boolean;
  menus?: ScriptMenuItem[];
};

// 后台脚本将会将代码注入到沙盒中
@IoC.Singleton(MessageHander, MessageSandbox, ResourceManager, ValueManager)
export default class Runtime {
  messageSandbox: MessageSandbox;

  scriptDAO: ScriptDAO;

  resourceManager: ResourceManager;

  valueManager: ValueManager;

  logger: Logger;

  scriptFlag: string;

  match: UrlMatch<ScriptRunResouce> = new UrlMatch();

  include: UrlInclude<ScriptRunResouce> = new UrlInclude();

  message: MessageHander;

  constructor(
    message: MessageHander,
    messageSandbox: MessageSandbox,
    resourceManager: ResourceManager,
    valueManager: ValueManager
  ) {
    this.message = message;
    this.scriptDAO = new ScriptDAO();
    this.messageSandbox = messageSandbox;
    this.resourceManager = resourceManager;
    this.valueManager = valueManager;
    this.scriptFlag = randomString(8);
    this.logger = LoggerCore.getInstance().logger({ component: "runtime" });
    ScriptManager.hook.addHook("upsert", this.scriptUpdate.bind(this));
    ScriptManager.hook.addHook("delete", this.scriptDelete.bind(this));
    ScriptManager.hook.addHook("enable", this.scriptUpdate.bind(this));
    ScriptManager.hook.addHook("disable", this.scriptUpdate.bind(this));
  }

  listenEvent(): void {
    this.scriptDAO.table.toArray((items) => {
      items.forEach((item) => {
        // 加载所有的脚本
        if (item.status === SCRIPT_STATUS_ENABLE) {
          this.enable(item);
        } else if (item.type === SCRIPT_TYPE_NORMAL) {
          // 只处理未开启的普通页面脚本
          this.disable(item);
        }
      });
    });
    // 接受消息,注入脚本
    // 获取注入源码
    const { scriptFlag } = this;
    let injectedSource = "";
    fetch(chrome.runtime.getURL("src/inject.js"))
      .then((resp) => resp.text())
      .then((source: string) => {
        injectedSource = dealScript(
          `(function (ScriptFlag) {\n${source}\n})('${scriptFlag}')`
        );
      });

    // 监听菜单创建
    const scriptMenu: Map<
      number,
      Map<
        number,
        {
          request: Request;
          channel: Channel;
        }[]
      >
    > = new Map();
    GMApi.hook.addHook("registerMenu", (request: Request, channel: Channel) => {
      // TODO: 暂时不处理后台脚本的菜单
      if (!request.sender.tabId) {
        return;
      }
      const senderId = request.sender.tabId;
      let tabMap = scriptMenu.get(senderId);
      if (!tabMap) {
        tabMap = new Map();
        scriptMenu.set(senderId, tabMap);
      }
      let menuArr = tabMap.get(request.scriptId);
      if (!menuArr) {
        menuArr = [];
        tabMap.set(request.scriptId, menuArr);
      }
      // 查询菜单是否已经存在
      for (let i = 0; menuArr.length; i += 1) {
        // id 相等 跳过,选第一个,并close链接
        if (menuArr[i].request.params[0] === request.params[0]) {
          channel.disChannel();
          return;
        }
      }
      menuArr.push({ request, channel });
      // 偷懒行为
      genScriptMenu(senderId, scriptMenu);
    });
    GMApi.hook.addHook("unregisterMenu", (id, request: Request) => {
      if (!request.sender.tabId) {
        return;
      }
      const senderId = request.sender.tabId;
      const tabMap = scriptMenu.get(senderId);
      if (tabMap) {
        const menuArr = tabMap.get(request.scriptId);
        if (menuArr) {
          // 从菜单数组中遍历删除
          for (let i = 0; i < menuArr.length; i += 1) {
            if (menuArr[i].request.params[0] === id) {
              menuArr.splice(i, 1);
              break;
            }
          }
          if (menuArr.length === 0) {
            tabMap.delete(request.scriptId);
          }
        }
        if (!Object.keys(tabMap).length) {
          scriptMenu.delete(senderId);
        }
      }
      // 偷懒行为
      genScriptMenu(senderId, scriptMenu);
    });

    // 监听页面切换加载菜单
    chrome.tabs.onActivated.addListener((activeInfo) => {
      genScriptMenu(activeInfo.tabId, scriptMenu);
    });

    // 给popup页面获取运行脚本,与菜单
    this.message.setHandler(
      "queryPageScript",
      (action: string, { url, tabId }: any) => {
        const tabMap = scriptMenu.get(tabId);
        const matchScripts = this.match.match(url);
        const scriptList: ScriptMenu[] = [];
        matchScripts.forEach((item) => {
          const menus: ScriptMenuItem[] = [];
          if (tabMap) {
            tabMap.get(item.id)?.forEach((scriptItem) => {
              menus.push({
                name: scriptItem.request.params[1],
                accessKey: scriptItem.request.params[2],
                id: scriptItem.request.params[0],
                sender: scriptItem.request.sender,
                channelFlag: scriptItem.channel.flag,
              });
            });
          }
          scriptList.push({
            id: item.id,
            name: item.name,
            enable: item.status === SCRIPT_STATUS_ENABLE,
            menus,
          });
        });
        return Promise.resolve({
          scriptList,
        });
      }
    );

    // content页发送页面加载完成消息,注入脚本
    this.message.setHandler(
      "pageLoad",
      (_action: string, data: any, sender: MessageSender) => {
        return new Promise((resolve) => {
          if (!sender) {
            return;
          }
          if (!(sender.url && sender.tabId)) {
            return;
          }

          const scripts = this.match.match(sender.url);
          const filter: ScriptRunResouce[] = [];

          scripts.forEach((script) => {
            if (script.status !== SCRIPT_STATUS_ENABLE) {
              return;
            }
            if (script.metadata.noframes) {
              if (sender.frameId !== 0) {
                return;
              }
            }
            filter.push(script);
          });
          if (!filter.length) {
            return;
          }

          resolve({ flag: scriptFlag, scripts: filter });

          // 注入运行框架
          chrome.tabs.executeScript(sender.tabId, {
            frameId: sender.frameId,
            code: `(function(){
                    let temp = document.createElement('script');
                    temp.setAttribute('type', 'text/javascript');
                    temp.innerHTML = "${injectedSource}";
                    temp.className = "injected-js";
                    document.documentElement.appendChild(temp)
                    temp.remove();
                }())`,
            runAt: "document_start",
          });
          // 注入脚本
          filter.forEach((script) => {
            let runAt = "document_idle";
            if (script.metadata["run-at"]) {
              [runAt] = script.metadata["run-at"];
            }
            switch (runAt) {
              case "document-body":
              case "document-menu":
              case "document-start":
                runAt = "document_start";
                break;
              case "document-end":
                runAt = "document_end";
                break;
              case "document-idle":
                runAt = "document_idle";
                break;
              default:
                runAt = "document_idle";
                break;
            }
            chrome.tabs.executeScript(sender.tabId!, {
              frameId: sender.frameId,
              code: `(function(){
                    let temp = document.createElement('script');
                    temp.setAttribute('type', 'text/javascript');
                    temp.innerHTML = "${script.code}";
                    temp.className = "injected-js";
                    document.documentElement.appendChild(temp)
                    temp.remove();
                }())`,
              runAt,
            });
          });

          // 角标和脚本
          chrome.browserAction.getBadgeText(
            {
              tabId: sender.tabId,
            },
            (res: string) => {
              chrome.browserAction.setBadgeText({
                text: (filter.length + (parseInt(res, 10) || 0)).toString(),
                tabId: sender.tabId,
              });
            }
          );
          chrome.browserAction.setBadgeBackgroundColor({
            color: "#4594d5",
            tabId: sender.tabId,
          });
        });
      }
    );
  }

  // 脚本发生变动
  scriptUpdate(script: Script): Promise<boolean> {
    if (script.status === SCRIPT_STATUS_ENABLE) {
      return this.enable(script as ScriptRunResouce);
    }
    return this.disable(script);
  }

  // 脚本删除
  scriptDelete(script: Script): Promise<boolean> {
    if (script.status === SCRIPT_STATUS_ENABLE) {
      return this.disable(script);
    }
    // 清理匹配资源
    this.match.del(<ScriptRunResouce>script);
    this.include.del(<ScriptRunResouce>script);
    return Promise.resolve(true);
  }

  // 脚本开启
  async enable(script: Script): Promise<boolean> {
    // 编译脚本运行资源
    const scriptRes = await this.buildScriptRunResource(script);
    if (script.type !== SCRIPT_TYPE_NORMAL) {
      return this.loadBackgroundScript(scriptRes);
    }
    return this.loadPageScript(scriptRes);
  }

  // 脚本关闭
  disable(script: Script): Promise<boolean> {
    if (script.type !== SCRIPT_TYPE_NORMAL) {
      return this.unloadBackgroundScript(script);
    }
    return this.unloadPageScript(script);
  }

  // 加载页面脚本
  loadPageScript(script: ScriptRunResouce) {
    // 重构code
    script.code = dealScript(
      `window['${script.flag}']=function(context){\n${script.code}\n}`
    );

    this.match.del(<ScriptRunResouce>script);
    this.include.del(<ScriptRunResouce>script);
    if (script.metadata.match) {
      script.metadata.match.forEach((url) => {
        try {
          this.match.add(url, script);
        } catch (e) {
          this.logger.error("url加载错误", Logger.E(e));
        }
      });
    }
    if (script.metadata.include) {
      script.metadata.include.forEach((url) => {
        try {
          this.include.add(url, script);
        } catch (e) {
          this.logger.error("url加载错误", Logger.E(e));
        }
      });
    }
    if (script.metadata.exclude) {
      script.metadata.exclude.forEach((url) => {
        try {
          this.include.exclude(url, script);
          this.match.exclude(url, script);
        } catch (e) {
          this.logger.error("url加载错误", Logger.E(e));
        }
      });
    }
    return Promise.resolve(true);
  }

  // 卸载页面脚本
  unloadPageScript(script: Script) {
    return this.loadPageScript(<ScriptRunResouce>script);
  }

  // 加载后台脚本
  loadBackgroundScript(script: ScriptRunResouce): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.messageSandbox
        .syncSend("enable", script)
        .then((resp) => {
          resolve(resp);
        })
        .catch((err) => {
          this.logger.error("后台脚本加载失败", Logger.E(err));
          reject(err);
        });
    });
  }

  // 卸载后台脚本
  unloadBackgroundScript(script: Script): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.messageSandbox
        .syncSend("disable", script.id)
        .then((resp) => {
          resolve(resp);
        })
        .catch((err) => {
          this.logger.error("后台脚本停止失败", Logger.E(err));
          reject(err);
        });
    });
  }

  async buildScriptRunResource(script: Script): Promise<ScriptRunResouce> {
    const ret: ScriptRunResouce = <ScriptRunResouce>Object.assign(script);

    // 自定义配置
    if (ret.selfMetadata) {
      ret.metadata = { ...ret.metadata };
      Object.keys(ret.selfMetadata).forEach((key) => {
        ret.metadata[key] = ret.selfMetadata![key];
      });
    }

    ret.value = await this.valueManager.getScriptValues(ret);

    ret.resource = await this.resourceManager.getScriptResources(ret);

    ret.flag = randomString(16);
    ret.code = compileScriptCode(ret);

    ret.grantMap = {};

    ret.metadata.grant?.forEach((val: string) => {
      ret.grantMap[val] = "ok";
    });

    return Promise.resolve(ret);
  }
}
