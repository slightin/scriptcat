// eslint-disable-next-line max-classes-per-file
import Dexie from "dexie";

export const db = new Dexie("ScriptCat");

export class Page {
  protected Page: number;

  protected Count: number;

  protected Order: string;

  protected Sort: "asc" | "desc";

  constructor(
    page: number,
    count: number,
    sort?: "asc" | "desc",
    order?: string
  ) {
    this.Page = page;
    this.Count = count;
    this.Order = order || "id";
    this.Sort = sort || "desc";
  }

  public page() {
    return this.Page;
  }

  public count() {
    return this.Count;
  }

  public order() {
    return this.Order;
  }

  public sort() {
    return this.Sort;
  }
}

export abstract class DAO<T> {
  public table!: Dexie.Table<T, number>;

  public tableName = "";

  public list(query: { [key: string]: any }, page?: Page) {
    if (!page) {
      return this.table.where(query).toArray();
    }
    let collect = this.table
      .where(query)
      .offset((page.page() - 1) * page.count())
      .limit(page.count());
    if (page.order() !== "id") {
      collect.sortBy(page.order());
    }
    if (page.sort() === "desc") {
      collect = collect.reverse();
    }
    return collect.toArray();
  }

  public find() {
    return this.table;
  }

  public findOne(where: { [key: string]: any }) {
    return this.table.where(where).first();
  }

  public async save(val: T): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const id = <number>(<any>val).id;
      if (!id) {
        delete (<any>val).id;
        this.table
          .add(val)
          .then((key) => {
            (<any>val).id = key;
            return resolve(val);
          })
          .catch((e) => reject(e));
      } else {
        this.table
          .update(id, val)
          .then(() => {
            return resolve(val);
          })
          .catch((e) => reject(e));
      }
    });
  }

  public findById(id: number) {
    return this.table.get(id);
  }

  public clear() {
    return this.table.clear();
  }

  public async delete(id: number | { [key: string]: any }) {
    if (typeof id === "number") {
      return this.table.delete(id);
    }
    return this.table.where(id).delete();
  }

  public update(id: number, changes: { [key: string]: any }) {
    return this.table.update(id, changes);
  }

  public count() {
    return this.table.count();
  }
}
