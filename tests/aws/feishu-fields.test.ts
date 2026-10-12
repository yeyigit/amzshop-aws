import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// 已从飞书删除的系统字段（规则见 docs/模块说明.md「飞书字段边界」）。这里只列全库唯一的字段名；
// 与保留字段同名的（库存参数「数据异常」「首次/最后同步时间」、活动日报「数据新鲜度」「毛利率」、资金流水「站点」、库存预警「预计到达」）由各模块用例按表断言。
const DELETED = [
  "资金交易明细", "退款明细", "售后原因同步信息", "售后原因类型", "售后原因来源", "配送日期",
  "预算事件时间", "已预警", "Placement明细", "对象稳定键", "去重指纹", "最近通知时间",
  "最近在途货件", "最近货件状态", "真实发货时间", "预计到达依据", "ETA可信度", "单位采购成本", "近期入库单位成本",
  "采购资金需求", "入库资金需求", "已知资金小计", "总资金需求", "资金币种", "费用明细",
  "预测性质", "缺货历史", "公式版本", "销量历史天数", "30日日均", "60日日均", "90日日均", "当前周季节系数", "库存阶段说明", "原始输入",
  "最新动态", "亚马逊时间来源", "时间精度", "首次发现已发货时间", "首次发现已送达时间", "运输时长（天）", "预处理要求",
  "价格观察时间", "结算分项", "亚马逊交易ID", "店铺账号", "亚马逊交易状态", "收支方向", "核算属性", "数据来源",
  // 广告调价改为人工复盘后（docs/模块说明.md「广告」）：旧决策任务专用字段停写并删除（投放词监控整表同时删除）。
  // 广告预警的「级别」「建议」「证据」与「Profile ID」同日删除，但名字太通用，不列在这里。
  "预警稳定键", "最近曝光下降", "近3日平均曝光", "此前7日平均曝光", "30日平均客单价", "曝光变化", "趋势解释", "首次提醒日期", "最近ACOS",
];

async function sources(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sources(full));
    else if (entry.name.endsWith(".ts")) output.push(full);
  }
  return output;
}

test("已从飞书删除的字段不再出现在任何写入代码里（字段名作为字符串字面量或属性键）", async () => {
  const hits: string[] = [];
  for (const file of await sources(path.join(root, "src"))) {
    const code = await readFile(file, "utf8");
    for (const name of DELETED) if (code.includes(`"${name}"`) || code.includes(`'${name}'`) || code.includes(`\`${name}\``)) hits.push(`${path.relative(root, file)}: ${name}`);
  }
  assert.deepEqual(hits, [], "已删除字段若要恢复，先改 docs/模块说明.md「飞书字段边界」，再在飞书重建字段");
});
