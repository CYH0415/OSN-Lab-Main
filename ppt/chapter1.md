Good evening, everyone. Now, I will begin the presentation of our project.

Our presentation is divided into the following sections:

Project Introduction & Data Collection

Data Cleaning & Dataset Construction

Feature Engineering & Model Input Preparation

Model Training & Evaluation

and Results Analysis

1. Project Introduction & Data Collection

First, I will briefly introduce the project and describe the process of data analysis and collection.

Google Play provides a questionnaire service for developers to get a potential content rating evaluation for their apps. Google has not disclosed the algorithm behind, so it can be regarded as a black-box model.

The core task of this project is to analyse this questionnaire, design a script to collect at least 1,000 sets of questionnaire responses and their rating results, and train a machine learning model for rating prediction.

The questionnaires are categorized into three types: Game, Social or Communication, and Other.

(Transition to next slide) This is the questionnaire interface.

Since the Social questionnaire contains fewer questions, there are only 4,096 combinations. This means little significance for the machine learning research, so it was excluded from our scope.

(transition)
For the other two categories, I implemented a DFS program to traverse the questions.

Specifically, the program starts from several root questions of the questionnaire. By clicking each option sequentially, it identifies the sub-questions associated with that choice, and then recursively traverses each sub-question. The program backtracks once it reaches a leaf node—meaning a point with no further sub-questions.

Ultimately, we obtained the following structure:
As you can see, the questionnaire consists of 14 root questions. A few of these root questions branch into several sub-questions, with a maximum depth of four layers.

(switch)

This is the structure for the other category.

(switch)

And this is a question for example. It has several subquestions regarding gambling elements in the app.

1. Questionnaire Sample Acquisition
(switch)
To acquire sufficient and well-distributed data, I used the following sampling methods:

1. Firstly, I select "No" for all questions to obtain the lowest rating result, which corresponds to the "All Ages" (General) classification.

2. Secondly, I Prioritized options that trigger sub-questions. This improves question coverage and lays the foundation for the next sampling.

3. Thirdly I manually annotated every option of each question by labeling the risk types involved (such as gambling, drugs, and in-app purchases) along with the severity level of each item. By filling out the questionnaire to include a single risk item, multiple risk items, and all risk items, we successfully covered sufficient data from Teen to Adult-Only ratings.

4. Lastly, I analysed the samples from the previous steps and collected data for options that appeared with lower frequencies.

(switch)
3. Final Data Distribution
The final distribution of the collected questionnaire data is shown in the chart. As you can see, each age rating category has been evenly and adequately covered.

大家好，今天我们介绍的主题是 GraphRAG

我们将分为如上的四个部分

首先是背景与挑战

LLM 的技术架构以及训练语料的日期，带来了面对训练外数据的知识幻觉问题，同时长文档推理又容易遇到上下文瓶颈

传统 RAG 技术只能获取文本片段，无法捕捉结构化关系，也难以掌握全局关系

为此，2024 年微软提出了 GraphRAG，通过将文本块存储为以实体为节点、关系为边的知识图谱，解决了上述难题

接下来将简单介绍其技术架构

GraphRAG 相比传统 RAG，在索引阶段将由 LLM 生成代表关系的三元组并以此构建关系图

而在查询阶段，则会用子图路径搜索和社区摘要算法寻找关联节点，最终生成可溯源、逻辑清晰的回答
