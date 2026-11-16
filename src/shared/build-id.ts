// 这次构建的标识，构建时由源码内容算出、注入后台和各页面，同一份源码两次构建得到同一个。
// 页面拿它和后台的比，对不上就是文件更新了、后台还没重新加载。单元测试不经构建，是 dev。
declare const __JIANMU_BUILD_ID__: string | undefined;

export const BUILD_ID: string = typeof __JIANMU_BUILD_ID__ === "string" ? __JIANMU_BUILD_ID__ : "dev";
