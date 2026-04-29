//go:build ignore

// 这是一个专门给 EdgeOne Pages CLI 留的"陷阱"文件。
// EdgeOne CLI 在编译 Go 云函数时，会递归遍历项目根目录的每个文件夹。
// 如果一个文件夹不包含 .go 文件，CLI 就会认为它是“运行时资源目录”，从而将整个目录原封不动复制到打包产物中！
// 加上这个 dummy .go 文件后，CLI 就会认为这是一个 Go 包目录，此时它只会复制 .go 文件，从而避免把庞大的 node_modules 或其他数据文件打包进云函数中。
package ignore
